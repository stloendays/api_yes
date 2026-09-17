import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { shell } from 'electron'
import type { CredentialView, Provider, TestResult } from '@shared/types'
import type { AppCore } from './context'
import { normalizeSameApiKeyState, toCredentialView, type OAuthTokens, type StoredCredential } from './store'
import { beginAnthropicAuth, exchangeAnthropicCode, splitPastedCode } from './oauth/anthropic-oauth'
import { beginOpenAIAuth, exchangeOpenAICode, OPENAI_OAUTH } from './oauth/openai-oauth'
import type { Pkce } from './oauth/pkce'
import { launchAntigravityLogin, testAntigravityCli } from './provider/antigravity-cli'
import { mt } from './i18n'

const CODEX_BASE = 'https://chatgpt.com/backend-api/codex'
const AGY_LOCAL_BASE = 'agy://official-cli'
const SESSION_TTL_MS = 5 * 60_000

interface OAuthSession {
  id: string
  provider: Provider
  name?: string
  mode: 'loopback' | 'paste'
  pkce?: Pkce
  loopback?: Server
  timer?: ReturnType<typeof setTimeout>
  poller?: ReturnType<typeof setInterval>
}

const RESULT_HTML = (ok: boolean, msg: string): string => `<!doctype html><html><head>
<meta charset="utf-8"><title>API-YES</title><style>
body{font-family:system-ui,sans-serif;background:#FBF7EF;color:#2B2B2B;display:grid;place-items:center;height:100vh;margin:0}
.card{border:2px solid #2B2B2B;border-radius:16px;padding:32px 40px;text-align:center;background:#fff;box-shadow:3px 3px 0 0 rgba(43,43,43,.85)}
h1{margin:.2em 0;font-size:22px}p{opacity:.7}
</style></head><body><div class="card"><h1>${ok ? mt('oauthpage.ok') : mt('oauthpage.fail')}</h1>
<p>${msg}</p><p>${mt('oauthpage.close')}</p></div></body></html>`

export function registerOAuthService(core: AppCore): void {
  const sessions = new Map<string, OAuthSession>()

  const views = (): CredentialView[] => {
    const credentials = core.store.data.credentials.slice().sort((a, b) => a.order - b.order)
    return credentials.map((c) => toCredentialView(c, credentials))
  }

  const createCredential = (provider: Provider, name: string | undefined, tokens: OAuthTokens): StoredCredential => {
    const now = Date.now()
    const order = core.store.data.credentials.reduce((m, c) => Math.max(m, c.order), -1) + 1
    const defaultName =
      provider === 'anthropic'
        ? mt('name.claudeSub')
        : provider === 'antigravity'
          ? 'AGY / Antigravity'
          : mt('name.chatgptSub')
    const baseUrl =
      provider === 'anthropic' ? 'https://api.anthropic.com' : provider === 'antigravity' ? AGY_LOCAL_BASE : CODEX_BASE
    const cred: StoredCredential = {
      id: randomUUID(),
      name: name?.trim() || defaultName,
      provider,
      kind: 'oauth',
      baseUrl,
      oauth: tokens,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      order
    }
    core.store.mutate((db) => {
      db.credentials.push(cred)
      normalizeSameApiKeyState(db.credentials)
    })
    core.broadcast('credentials.changed', views())
    return cred
  }

  const cleanup = (s: OAuthSession): void => {
    if (s.timer) clearTimeout(s.timer)
    if (s.poller) clearInterval(s.poller)
    if (s.loopback) s.loopback.close()
    sessions.delete(s.id)
  }

  // ── loopback capture (OpenAI) ──────────────────────────────────────────────
  const startLoopback = (s: OAuthSession): void => {
    const pkce = s.pkce
    if (!pkce) throw new Error('Missing OAuth PKCE state')
    const srv = createServer((req, res) => {
      const u = new URL(req.url ?? '/', `http://localhost:${OPENAI_OAUTH.redirectPort}`)
      if (!u.pathname.startsWith('/auth/callback')) {
        res.writeHead(404)
        res.end()
        return
      }
      const code = u.searchParams.get('code')
      const state = u.searchParams.get('state')
      const error = u.searchParams.get('error')
      void (async (): Promise<void> => {
        try {
          if (error) throw new Error(error)
          if (!code) throw new Error(mt('oauth.missingCode'))
          if (state && state !== pkce.state) throw new Error(mt('oauth.stateMismatch'))
          core.broadcast('oauth.status', { sessionId: s.id, phase: 'exchanging' })
          const tokens = await exchangeOpenAICode({ code, verifier: pkce.verifier })
          const cred = createCredential('openai', s.name, tokens)
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(RESULT_HTML(true, mt('oauth.connectedChatgpt')))
          core.broadcast('oauth.status', { sessionId: s.id, phase: 'success', credentialId: cred.id })
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(RESULT_HTML(false, message))
          core.broadcast('oauth.status', { sessionId: s.id, phase: 'error', message })
        } finally {
          cleanup(s)
        }
      })()
    })
    srv.on('error', (e: NodeJS.ErrnoException) => {
      const message =
        e.code === 'EADDRINUSE'
          ? mt('oauth.portInUse', { port: OPENAI_OAUTH.redirectPort })
          : (e.message ?? String(e))
      core.broadcast('oauth.status', { sessionId: s.id, phase: 'error', message })
      cleanup(s)
    })
    srv.listen(OPENAI_OAUTH.redirectPort)
    s.loopback = srv
  }

  // ── AGY browser sign-in via the official CLI ──────────────────────────────
  const finishAgyIfReady = async (s: OAuthSession): Promise<boolean> => {
    const r = await testAntigravityCli()
    if (!r.ok) return false
    const cred = createCredential('antigravity', s.name, {
      // Deliberately not the upstream Google token: the official AGY CLI owns that secret in the OS keyring.
      accessToken: 'managed-by-official-agy-cli',
      account: { plan: 'AGY CLI OAuth' },
      extra: { authManagedBy: 'agy-cli' }
    })
    core.broadcast('oauth.status', { sessionId: s.id, phase: 'success', credentialId: cred.id })
    cleanup(s)
    return true
  }

  const startAgyLogin = async (s: OAuthSession): Promise<void> => {
    // Already signed in: complete without opening another terminal.
    if (await finishAgyIfReady(s)) return
    await launchAntigravityLogin()
    let checking = false
    s.poller = setInterval(() => {
      if (checking || !sessions.has(s.id)) return
      checking = true
      void finishAgyIfReady(s)
        .catch(() => false)
        .finally(() => {
          checking = false
        })
    }, 2000)
  }

  core.commands.register('oauth.begin', async ({ provider, name }) => {
    const id = randomUUID()
    if (provider === 'anthropic') {
      const handle = beginAnthropicAuth()
      const s: OAuthSession = { id, provider, name, mode: 'paste', pkce: handle.pkce }
      s.timer = setTimeout(() => cleanup(s), SESSION_TTL_MS)
      sessions.set(id, s)
      void shell.openExternal(handle.url)
      return { sessionId: id, authUrl: handle.url, mode: 'paste' as const }
    }
    if (provider === 'antigravity') {
      const s: OAuthSession = { id, provider, name, mode: 'loopback' }
      s.timer = setTimeout(() => {
        core.broadcast('oauth.status', {
          sessionId: id,
          phase: 'error',
          message: 'AGY sign-in timed out. Complete the browser sign-in from the AGY terminal and try again.'
        })
        cleanup(s)
      }, SESSION_TTL_MS)
      sessions.set(id, s)
      // Return first so the renderer can attach its status listener before a fast existing-session check succeeds.
      setTimeout(() => {
        void startAgyLogin(s).catch((e) => {
          const message = e instanceof Error ? e.message : String(e)
          core.broadcast('oauth.status', { sessionId: id, phase: 'error', message })
          cleanup(s)
        })
      }, 100)
      return {
        sessionId: id,
        authUrl: 'https://antigravity.google/docs/cli/install/',
        mode: 'loopback' as const
      }
    }
    const handle = beginOpenAIAuth()
    const s: OAuthSession = { id, provider, name, mode: 'loopback', pkce: handle.pkce }
    s.timer = setTimeout(() => cleanup(s), SESSION_TTL_MS)
    sessions.set(id, s)
    startLoopback(s)
    void shell.openExternal(handle.url)
    return { sessionId: id, authUrl: handle.url, mode: 'loopback' as const }
  })

  core.commands.register('oauth.submitCode', async ({ sessionId, code }): Promise<TestResult> => {
    const s = sessions.get(sessionId)
    if (!s) return { ok: false, at: Date.now(), message: mt('oauth.sessionExpired') }
    if (s.mode !== 'paste' || !s.pkce) return { ok: false, at: Date.now(), message: mt('oauth.noPasteNeeded') }
    try {
      core.broadcast('oauth.status', { sessionId, phase: 'exchanging' })
      const { code: rawCode, state } = splitPastedCode(code)
      const tokens = await exchangeAnthropicCode({
        code: rawCode,
        state: state ?? s.pkce.state,
        verifier: s.pkce.verifier
      })
      const cred = createCredential('anthropic', s.name, tokens)
      core.broadcast('oauth.status', { sessionId, phase: 'success', credentialId: cred.id })
      cleanup(s)
      return { ok: true, at: Date.now(), message: mt('oauth.success') }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      core.broadcast('oauth.status', { sessionId, phase: 'error', message })
      return { ok: false, at: Date.now(), message }
    }
  })

  core.commands.register('oauth.cancel', ({ sessionId }) => {
    const s = sessions.get(sessionId)
    if (s) {
      cleanup(s)
      core.broadcast('oauth.status', { sessionId, phase: 'cancelled' })
    }
  })
}
