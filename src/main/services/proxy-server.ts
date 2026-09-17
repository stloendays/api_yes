import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import type { ProxyEndpoint, ProxyServerStatus, Provider } from '@shared/types'
import type { AppCore } from './context'
import { codexModels, ensureAccessToken, mergeHeaderValue, resolveForward } from './provider/upstream'
import { createUsageMeter, type ParsedUsage } from './provider/usage'
import type { StoredCredential } from './store'
import { recordDailyUsage, usageBucket } from './usage-history'
import { mt } from './i18n'
import {
  CODEX_BASE,
  chatToResponses,
  codexHeaders,
  collectCodexAsChat,
  streamCodexAsChat
} from './provider/codex'
import {
  listAntigravityModels,
  runAntigravityNonStream,
  runAntigravityStream,
  type AgyUsage
} from './provider/antigravity-cli'

const isWildcard = (host: string): boolean => host === '0.0.0.0' || host === '::'

function primaryLanIPv4(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address
    }
  }
  return undefined
}

function isLoopback(addr?: string): boolean {
  if (!addr) return false
  return addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.')
}

const STRIP_REQ = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'accept-encoding'
])
const STRIP_RES = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length'
])

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': '*'
}

/**
 * The single local reverse-proxy server. A client points its OpenAI/Anthropic base URL at
 * http://host:port and authenticates with a proxy key; that key selects the endpoint → credential
 * → upstream. AGY credentials use the same local-key gate but execute through the official AGY CLI
 * session, so the upstream Google OAuth secret remains in the OS keyring owned by AGY.
 */
export class ProxyServer {
  private server: Server | null = null
  private status: ProxyServerStatus
  constructor(private readonly core: AppCore) {
    this.status = { running: false, host: this.desiredHost(), port: core.store.data.settings.proxyPort }
  }

  private desiredHost(): string {
    const anyLan = this.core.store.data.proxies.some((p) => p.enabled && p.localOnly === false)
    return anyLan ? '0.0.0.0' : '127.0.0.1'
  }

  getStatus(): ProxyServerStatus {
    return { ...this.status }
  }

  private setStatus(patch: Partial<ProxyServerStatus>): void {
    this.status = { ...this.status, ...patch }
    this.core.broadcast('proxy.status', this.getStatus())
  }

  async start(): Promise<ProxyServerStatus> {
    if (this.server) return this.getStatus()
    const host = this.desiredHost()
    const port = this.core.store.data.settings.proxyPort
    const server = createServer((req, res) => void this.handle(req, res))
    return new Promise<ProxyServerStatus>((resolve) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        this.server = null
        const msg = e.code === 'EADDRINUSE' ? mt('proxy.portTaken', { port }) : (e.message ?? String(e))
        this.setStatus({ running: false, host, port, error: msg })
        resolve(this.getStatus())
      })
      server.listen(port, host, () => {
        this.server = server
        this.setStatus({
          running: true,
          host,
          port,
          lanHost: isWildcard(host) ? primaryLanIPv4() : undefined,
          error: undefined
        })
        resolve(this.getStatus())
      })
    })
  }

  async stop(): Promise<ProxyServerStatus> {
    const server = this.server
    this.server = null
    if (!server) {
      this.setStatus({ running: false })
      return this.getStatus()
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    this.setStatus({ running: false, error: undefined })
    return this.getStatus()
  }

  async restart(): Promise<ProxyServerStatus> {
    await this.stop()
    return this.start()
  }

  async applySettings(): Promise<ProxyServerStatus> {
    const host = this.desiredHost()
    const port = this.core.store.data.settings.proxyPort
    if (this.server) {
      if (host === this.status.host && port === this.status.port) return this.getStatus()
      return this.restart()
    }
    this.setStatus({
      host,
      port,
      lanHost: isWildcard(host) ? primaryLanIPv4() : undefined,
      error: undefined
    })
    return this.getStatus()
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      res.end()
      return
    }
    if (url.pathname === '/' || url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', ...CORS })
      res.end(JSON.stringify({ name: 'API-YES', ok: true, status: this.getStatus() }))
      return
    }

    const key = extractKey(req)
    if (!key) return this.fail(res, 401, mt('proxy.missingKey'))

    const endpoints = this.core.store.data.proxies.filter((p) => p.key === key)
    if (endpoints.length === 0) return this.fail(res, 401, mt('proxy.invalidKey'))
    const endpoint =
      endpoints.find((p) => p.sameKeyMode === true && p.sameKeyActive === true) ?? endpoints[0]
    if (!endpoint.enabled) return this.fail(res, 403, mt('proxy.keyDisabled'))
    const cred = this.core.store.data.credentials.find((c) => c.id === endpoint.credentialId)
    if (!cred) return this.fail(res, 502, mt('proxy.credGone'))
    const provider = cred.provider
    if (cred.enabled === false) return this.fail(res, 403, mt('proxy.credDisabled'), provider)
    if (endpoint.localOnly !== false && !isLoopback(req.socket.remoteAddress)) {
      return this.fail(res, 403, mt('proxy.localOnly'), provider)
    }
    if (
      endpoint.limitTotalTokens &&
      endpoint.usage.inputTokens + endpoint.usage.outputTokens >= endpoint.limitTotalTokens
    ) {
      return this.fail(res, 429, mt('proxy.capHit'), provider)
    }

    let rawBody: Buffer
    try {
      rawBody = await readBody(req)
    } catch {
      return this.fail(res, 400, mt('proxy.readBodyFailed'), provider)
    }

    // AGY is presented as an OpenAI-compatible local API, but its upstream execution is the
    // official `agy` headless CLI using the user's cached OAuth session in the OS keyring.
    if (cred.provider === 'antigravity') {
      if (/(^|\/)models\/?$/.test(url.pathname)) return this.serveAntigravityModels(res)
      if (/\/chat\/completions\/?$/.test(url.pathname)) {
        return this.handleAntigravityChat(res, endpoint, rawBody)
      }
      return this.fail(res, 404, `AGY local API route not supported: ${url.pathname}`, 'antigravity')
    }

    // ChatGPT/Codex OAuth speaks ONLY the Responses API behind Cloudflare. Adapt common OpenAI
    // surfaces so ordinary clients work.
    if (cred.provider === 'openai' && cred.kind === 'oauth') {
      if (/(^|\/)models\/?$/.test(url.pathname)) return this.serveCodexModels(res)
      if (/\/chat\/completions\/?$/.test(url.pathname)) {
        return this.handleCodexChat(res, cred, endpoint, rawBody)
      }
    }

    let target: Awaited<ReturnType<typeof resolveForward>>
    try {
      target = await resolveForward(this.core, cred, url.pathname, url.search)
    } catch (e) {
      return this.fail(res, 502, errText(e), provider)
    }

    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase()
      if (STRIP_REQ.has(lk) || target.dropHeaders.includes(lk)) continue
      if (v === undefined) continue
      headers[lk] = Array.isArray(v) ? v.join(', ') : v
    }
    Object.assign(headers, target.setHeaders)
    for (const [k, v] of Object.entries(target.mergeHeaders ?? {})) {
      const lk = k.toLowerCase()
      headers[lk] = mergeHeaderValue(headers[lk], v)
    }
    headers['accept-encoding'] = 'identity'

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && rawBody.length > 0
    const sendBody = hasBody && target.transformBody ? target.transformBody(rawBody) : rawBody
    if (hasBody) headers['content-length'] = String(sendBody.length)

    let upstream: Response
    try {
      upstream = await fetch(target.url, {
        method: req.method,
        headers,
        body: hasBody ? sendBody : undefined
      })
    } catch (e) {
      return this.fail(res, 502, `${mt('proxy.upstreamFailed', { e: errText(e) })} → ${target.url}`, provider)
    }

    const outHeaders: Record<string, string> = { ...CORS }
    upstream.headers.forEach((value, name) => {
      if (!STRIP_RES.has(name.toLowerCase())) outHeaders[name] = value
    })
    res.writeHead(upstream.status, outHeaders)

    const contentType = upstream.headers.get('content-type') ?? ''
    const stripInjectedUsage =
      upstream.ok &&
      cred.provider === 'openai' &&
      hasBody &&
      sendBody !== rawBody &&
      contentType.includes('text/event-stream')

    const meter = upstream.ok ? createUsageMeter(cred.provider, contentType) : null
    const dec = new TextDecoder()
    const enc = stripInjectedUsage ? new TextEncoder() : null
    const committed = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 }
    let billModel: string | undefined
    let billedAny = false
    const commit = (snap: ParsedUsage | null): void => {
      if (!snap) return
      if (snap.model) billModel = snap.model
      const delta = {
        inputTokens: Math.max(0, snap.inputTokens - committed.inputTokens),
        outputTokens: Math.max(0, snap.outputTokens - committed.outputTokens),
        cachedTokens: Math.max(0, snap.cachedTokens - committed.cachedTokens),
        reasoningTokens: Math.max(0, snap.reasoningTokens - committed.reasoningTokens)
      }
      if (delta.inputTokens || delta.outputTokens || delta.cachedTokens || delta.reasoningTokens) {
        committed.inputTokens += delta.inputTokens
        committed.outputTokens += delta.outputTokens
        committed.cachedTokens += delta.cachedTokens
        committed.reasoningTokens += delta.reasoningTokens
        this.billTokens(endpoint.id, delta)
        billedAny = true
      }
    }
    const meterText = (text: string): void => {
      if (!meter || !text) return
      try {
        commit(meter.push(text))
      } catch {
        /* usage is best-effort */
      }
    }
    let fwd = ''
    const forwardFiltered = (text: string, flush: boolean): void => {
      if (!enc) return
      fwd += text
      let out = ''
      let nl: number
      while ((nl = fwd.indexOf('\n')) >= 0) {
        const line = fwd.slice(0, nl + 1)
        fwd = fwd.slice(nl + 1)
        if (!isUsageOnlyDataLine(line)) out += line
      }
      if (flush && fwd && !isUsageOnlyDataLine(fwd)) {
        out += fwd
        fwd = ''
      }
      if (out) {
        try {
          res.write(enc.encode(out))
        } catch {
          /* client gone */
        }
      }
    }

    if (upstream.body) {
      const reader = upstream.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (stripInjectedUsage) {
            const text = dec.decode(value, { stream: true })
            meterText(text)
            forwardFiltered(text, false)
          } else {
            res.write(Buffer.from(value))
            meterText(dec.decode(value, { stream: true }))
          }
        }
      } catch {
        /* client disconnected mid-stream — keep whatever we already billed */
      }
      const tail = dec.decode()
      meterText(tail)
      if (stripInjectedUsage) forwardFiltered(tail, true)
    }
    res.end()

    if (meter) {
      try {
        commit(meter.end())
      } catch {
        /* usage is best-effort */
      }
      if (billedAny) {
        this.billRequest(endpoint.id, billModel, {
          inputTokens: committed.inputTokens,
          outputTokens: committed.outputTokens
        })
      }
    }
  }

  private async serveAntigravityModels(res: ServerResponse): Promise<void> {
    const r = await listAntigravityModels()
    if (!r.ok) return this.fail(res, 502, r.message, 'antigravity')
    const data = r.models.map((m) => ({ id: m.id, object: 'model', owned_by: 'google-antigravity' }))
    res.writeHead(200, { 'content-type': 'application/json', ...CORS })
    res.end(JSON.stringify({ object: 'list', data }))
  }

  private async handleAntigravityChat(
    res: ServerResponse,
    endpoint: ProxyEndpoint,
    rawBody: Buffer
  ): Promise<void> {
    let chat: Record<string, unknown>
    try {
      chat = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>
    } catch {
      return this.fail(res, 400, mt('proxy.badJson'), 'antigravity')
    }
    const model = typeof chat.model === 'string' && chat.model.trim() ? chat.model : 'antigravity-default'
    const wantStream = chat.stream === true

    if (!wantStream) {
      try {
        const out = await runAntigravityNonStream(chat)
        const body = {
          id: `chatcmpl-agy-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: out.text },
              finish_reason: 'stop'
            }
          ],
          usage: {
            prompt_tokens: out.usage.inputTokens,
            completion_tokens: out.usage.outputTokens,
            total_tokens: out.usage.inputTokens + out.usage.outputTokens,
            prompt_tokens_details: { cached_tokens: out.usage.cachedTokens },
            completion_tokens_details: { reasoning_tokens: out.usage.reasoningTokens }
          }
        }
        res.writeHead(200, { 'content-type': 'application/json', ...CORS })
        res.end(JSON.stringify(body))
        this.billAgy(endpoint.id, model, out.usage)
        return
      } catch (e) {
        return this.fail(res, 502, `AGY request failed: ${errText(e)}`, 'antigravity')
      }
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...CORS
    })
    const id = `chatcmpl-agy-${Date.now()}`
    const created = Math.floor(Date.now() / 1000)
    const send = (obj: unknown): void => {
      if (!res.destroyed) res.write(`data: ${JSON.stringify(obj)}\n\n`)
    }
    send({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
    })

    let child: { kill: () => boolean } | undefined
    const onClose = (): void => {
      if (!res.writableEnded) child?.kill()
    }
    res.once('close', onClose)
    try {
      const usage = await runAntigravityStream(
        chat,
        (delta) =>
          send({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
          }),
        (p) => {
          child = p
        }
      )
      if (!res.destroyed) {
        send({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        })
        const streamOptions = chat.stream_options as Record<string, unknown> | undefined
        if (streamOptions?.include_usage === true) {
          send({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [],
            usage: {
              prompt_tokens: usage.inputTokens,
              completion_tokens: usage.outputTokens,
              total_tokens: usage.inputTokens + usage.outputTokens,
              prompt_tokens_details: { cached_tokens: usage.cachedTokens },
              completion_tokens_details: { reasoning_tokens: usage.reasoningTokens }
            }
          })
        }
        res.write('data: [DONE]\n\n')
        res.end()
      }
      this.billAgy(endpoint.id, model, usage)
    } catch (e) {
      if (!res.destroyed) {
        send({ error: { message: `AGY request failed: ${errText(e)}`, type: 'api_yes_proxy_error' } })
        res.write('data: [DONE]\n\n')
        res.end()
      }
    } finally {
      res.off('close', onClose)
    }
  }

  private billAgy(proxyId: string, model: string, usage: AgyUsage): void {
    this.bill(proxyId, { ...usage, model })
  }

  private serveCodexModels(res: ServerResponse): void {
    const data = codexModels(this.core).map((id) => ({ id, object: 'model', owned_by: 'openai' }))
    res.writeHead(200, { 'content-type': 'application/json', ...CORS })
    res.end(JSON.stringify({ object: 'list', data }))
  }

  private async handleCodexChat(
    res: ServerResponse,
    cred: StoredCredential,
    endpoint: ProxyEndpoint,
    rawBody: Buffer
  ): Promise<void> {
    let chat: Record<string, unknown>
    try {
      chat = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>
    } catch {
      return this.fail(res, 400, mt('proxy.badJson'), 'openai')
    }
    const wantStream = chat.stream === true
    const model = typeof chat.model === 'string' ? chat.model : codexModels(this.core)[0]

    let token: string
    try {
      token = await ensureAccessToken(this.core, cred)
    } catch (e) {
      return this.fail(res, 502, errText(e), 'openai')
    }
    const accountId = cred.oauth?.extra?.chatgptAccountId as string | undefined

    let upstream: Response
    try {
      upstream = await fetch(`${CODEX_BASE}/responses`, {
        method: 'POST',
        headers: codexHeaders(token, accountId),
        body: JSON.stringify(chatToResponses(chat))
      })
    } catch (e) {
      return this.fail(res, 502, mt('proxy.upstreamFailed', { e: errText(e) }), 'openai')
    }
    if (!upstream.ok || !upstream.body) {
      const text = (await upstream.text().catch(() => '')).slice(0, 400)
      return this.fail(res, upstream.status || 502, mt('proxy.upstreamError', { t: text || upstream.statusText }), 'openai')
    }

    if (wantStream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...CORS
      })
      let usage: Awaited<ReturnType<typeof streamCodexAsChat>> = null
      try {
        usage = await streamCodexAsChat(upstream.body, model, (s) => res.write(s))
      } catch {
        /* client likely disconnected */
      }
      res.end()
      if (usage) this.bill(endpoint.id, { ...usage, model })
    } else {
      const { body, usage } = await collectCodexAsChat(upstream.body, model)
      res.writeHead(200, { 'content-type': 'application/json', ...CORS })
      res.end(body)
      if (usage) this.bill(endpoint.id, { ...usage, model })
    }
  }

  private billTokens(
    proxyId: string,
    delta: { inputTokens: number; outputTokens: number; cachedTokens: number; reasoningTokens: number }
  ): void {
    let updated: ProxyEndpoint | undefined
    this.core.store.mutate((db) => {
      const p = db.proxies.find((x) => x.id === proxyId)
      if (!p) return
      p.usage.inputTokens += delta.inputTokens
      p.usage.outputTokens += delta.outputTokens
      p.usage.cachedTokens += delta.cachedTokens
      p.usage.reasoningTokens += delta.reasoningTokens
      p.usage.lastUsedAt = Date.now()
      updated = p
    })
    if (updated) this.core.broadcast('proxy.usage', { proxyId, usage: updated.usage })
  }

  private billRequest(
    proxyId: string,
    model?: string,
    totals?: { inputTokens: number; outputTokens: number }
  ): void {
    let updated: ProxyEndpoint | undefined
    this.core.store.mutate((db) => {
      const p = db.proxies.find((x) => x.id === proxyId)
      if (!p) return
      p.usage.requests += 1
      if (model) {
        const m = usageBucket(p.usage.byModel, model)
        m.requests += 1
        if (totals) {
          m.inputTokens += totals.inputTokens
          m.outputTokens += totals.outputTokens
        }
      }
      recordDailyUsage(db, p.credentialId, p.id, model, totals ?? { inputTokens: 0, outputTokens: 0 })
      updated = p
    })
    if (updated) this.core.broadcast('proxy.usage', { proxyId, usage: updated.usage })
  }

  private bill(
    proxyId: string,
    usage: { inputTokens: number; outputTokens: number; cachedTokens: number; reasoningTokens: number; model?: string }
  ): void {
    this.billTokens(proxyId, usage)
    this.billRequest(proxyId, usage.model, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens })
  }

  private fail(res: ServerResponse, status: number, message: string, provider?: Provider): void {
    console.warn(`[proxy] ${status}: ${message}`)
    if (status >= 500) this.core.broadcast('toast', { kind: 'error', message: mt('proxy.toast', { status, message }) })
    const body =
      provider === 'anthropic'
        ? { type: 'error', error: { type: 'api_error', message } }
        : { error: { message, type: 'api_yes_proxy_error', code: status } }
    res.writeHead(status, { 'content-type': 'application/json', ...CORS })
    res.end(JSON.stringify(body))
  }
}

function errText(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause
    const causeMsg = cause instanceof Error ? cause.message : cause ? String(cause) : ''
    return causeMsg ? `${e.message}（${causeMsg}）` : e.message
  }
  return String(e)
}

function isUsageOnlyDataLine(rawLine: string): boolean {
  const line = rawLine.trim()
  if (!line.startsWith('data:')) return false
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return false
  try {
    const o = JSON.parse(payload) as { choices?: unknown; usage?: unknown }
    return (!Array.isArray(o.choices) || o.choices.length === 0) && o.usage != null
  } catch {
    return false
  }
}

function extractKey(req: IncomingMessage): string | null {
  const auth = req.headers['authorization']
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim()
  const xkey = req.headers['x-api-key']
  if (typeof xkey === 'string' && xkey.trim()) return xkey.trim()
  return null
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
