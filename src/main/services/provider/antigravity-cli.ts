import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import type { ModelInfo, TestResult, UsageReport } from '@shared/types'

const execFileAsync = promisify(execFile)
const AGY_TIMEOUT_MS = 5 * 60_000

export interface AgyUsage {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  reasoningTokens: number
}

interface AgyJsonUsage {
  input_tokens?: number
  output_tokens?: number
  thinking_tokens?: number
  cache_read_tokens?: number
  total_tokens?: number
}

interface AgyJsonResult {
  status?: string
  response?: string
  error?: string
  usage?: AgyJsonUsage
}

function normalizeUsage(raw?: AgyJsonUsage): AgyUsage {
  return {
    inputTokens: Number(raw?.input_tokens) || 0,
    outputTokens: Number(raw?.output_tokens) || 0,
    cachedTokens: Number(raw?.cache_read_tokens) || 0,
    reasoningTokens: Number(raw?.thinking_tokens) || 0
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Locate the official AGY executable. PATH remains the final fallback. */
export async function resolveAgyExecutable(): Promise<string> {
  const candidates: string[] = []
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    if (local) candidates.push(join(local, 'agy', 'bin', 'agy.exe'))
  } else {
    candidates.push(join(homedir(), '.local', 'bin', 'agy'))
  }
  for (const p of candidates) if (await exists(p)) return p
  return process.platform === 'win32' ? 'agy.exe' : 'agy'
}

async function agyExec(args: string[], timeout = 30_000): Promise<{ stdout: string; stderr: string }> {
  const exe = await resolveAgyExecutable()
  const r = await execFileAsync(exe, args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  })
  return { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
}

export async function listAntigravityModels(): Promise<{
  ok: boolean
  models: ModelInfo[]
  message: string
}> {
  try {
    const { stdout } = await agyExec(['models'], 20_000)
    const models: ModelInfo[] = []
    for (const raw of stdout.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      const m = /^(\S+)\s{2,}(.+)$/.exec(line) ?? /^(\S+)\s+(.+)$/.exec(line)
      if (!m) continue
      const id = m[1].trim()
      const label = m[2].trim()
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) continue
      models.push({ id, label })
    }
    if (!models.length) return { ok: false, models: [], message: 'AGY returned no models. Sign in to AGY first.' }
    return { ok: true, models, message: `AGY connected · ${models.length} models available` }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, models: [], message: `AGY is not authenticated or not installed: ${msg}` }
  }
}

export async function testAntigravityCli(): Promise<TestResult> {
  const at = Date.now()
  const r = await listAntigravityModels()
  return { ok: r.ok, at, message: r.message }
}

export function antigravityUsageReport(): UsageReport {
  return {
    ok: true,
    provider: 'antigravity',
    at: Date.now(),
    windows: [],
    message: 'AGY account quota is managed by the official CLI; local API token usage is tracked by API-YES.'
  }
}

/**
 * Launch the official AGY TUI in a visible terminal. On an unsigned-in machine AGY itself opens
 * Google's browser sign-in and stores the resulting session in the OS keyring. API-YES never
 * scrapes browser cookies or copies the upstream OAuth token into a client-visible field.
 */
export async function launchAntigravityLogin(): Promise<void> {
  const exe = await resolveAgyExecutable()
  if (process.platform === 'win32') {
    const command = `start "AGY Login" cmd.exe /k "\"${exe}\""`
    const p = spawn('cmd.exe', ['/d', '/s', '/c', command], { detached: true, stdio: 'ignore', windowsHide: false })
    p.unref()
    return
  }
  if (process.platform === 'darwin') {
    const safe = exe.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const p = spawn('osascript', ['-e', `tell application "Terminal" to do script "${safe}"`], {
      detached: true,
      stdio: 'ignore'
    })
    p.unref()
    return
  }
  const p = spawn('x-terminal-emulator', ['-e', exe], { detached: true, stdio: 'ignore' })
  p.unref()
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : String(content)
  const out: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if ((b.type === 'text' || b.type === 'input_text') && typeof b.text === 'string') out.push(b.text)
  }
  return out.join('\n')
}

function chatToPrompt(chat: Record<string, unknown>): string {
  const messages = Array.isArray(chat.messages) ? chat.messages : []
  const lines = [
    'You are serving as the model backend for an OpenAI-compatible local API.',
    'Answer the conversation directly. Do not inspect, edit, or execute local workspace files or commands.',
    'Return only the assistant response requested by the conversation.',
    ''
  ]
  for (const item of messages) {
    if (!item || typeof item !== 'object') continue
    const m = item as Record<string, unknown>
    const role = typeof m.role === 'string' ? m.role : 'user'
    const text = textFromContent(m.content)
    if (text) lines.push(`[${role.toUpperCase()}]\n${text}\n`)
  }
  if (Array.isArray(chat.tools) && chat.tools.length) {
    lines.push('[NOTE]\nClient-side OpenAI tool calls are not exposed through the AGY CLI bridge; answer without calling local tools.\n')
  }
  lines.push('[ASSISTANT]')
  return lines.join('\n')
}

async function sandboxDir(): Promise<string> {
  const dir = join(app.getPath('userData'), 'agy-api-sandbox')
  await mkdir(dir, { recursive: true })
  return dir
}

function agyChatArgs(chat: Record<string, unknown>, format: 'json' | 'stream-json'): string[] {
  const args = ['-p', chatToPrompt(chat), '--output-format', format, '--sandbox', '--print-timeout', '5m']
  const model = typeof chat.model === 'string' ? chat.model.trim() : ''
  if (model && model !== 'antigravity-default') args.push('--model', model)
  return args
}

export async function runAntigravityNonStream(chat: Record<string, unknown>): Promise<{
  text: string
  usage: AgyUsage
}> {
  const exe = await resolveAgyExecutable()
  const cwd = await sandboxDir()
  const r = await execFileAsync(exe, agyChatArgs(chat, 'json'), {
    cwd,
    encoding: 'utf8',
    timeout: AGY_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  })
  let obj: AgyJsonResult
  try {
    obj = JSON.parse(String(r.stdout ?? '')) as AgyJsonResult
  } catch {
    throw new Error(`AGY returned invalid JSON: ${String(r.stdout ?? '').slice(0, 300)}`)
  }
  if (obj.status && obj.status !== 'SUCCESS') throw new Error(obj.error || `AGY ended with ${obj.status}`)
  return { text: obj.response ?? '', usage: normalizeUsage(obj.usage) }
}

/** Stream one AGY headless turn and expose only assistant text deltas + final usage. */
export async function runAntigravityStream(
  chat: Record<string, unknown>,
  onText: (delta: string) => void,
  onProcess?: (child: ChildProcessWithoutNullStreams) => void
): Promise<AgyUsage> {
  const exe = await resolveAgyExecutable()
  const cwd = await sandboxDir()
  const child = spawn(exe, agyChatArgs(chat, 'stream-json'), {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  }) as ChildProcessWithoutNullStreams
  onProcess?.(child)

  return new Promise<AgyUsage>((resolve, reject) => {
    let buf = ''
    let err = ''
    let finalUsage: AgyUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 }
    let terminalError = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('AGY request timed out'))
    }, AGY_TIMEOUT_MS)

    const consumeLine = (line: string): void => {
      if (!line.trim()) return
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      if (obj.event === 'step_update') {
        const step = obj.step_update as Record<string, unknown> | undefined
        if (step?.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta) {
          onText(step.text_delta)
        }
      }
      if (obj.event === 'result') {
        const result = obj.result as AgyJsonResult | undefined
        if (result?.usage) finalUsage = normalizeUsage(result.usage)
        if (result?.status && result.status !== 'SUCCESS') terminalError = result.error || `AGY ended with ${result.status}`
      }
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        consumeLine(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      err += chunk
      if (err.length > 4096) err = err.slice(-4096)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (buf.trim()) consumeLine(buf)
      if (terminalError) return reject(new Error(terminalError))
      if (code !== 0) return reject(new Error(err.trim() || `AGY exited with code ${code}`))
      resolve(finalUsage)
    })
  })
}
