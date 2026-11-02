import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { discoverJmsJmxConfig, type JmsJmxConfig } from './jms-jmx-config.ts'
import type { JmsJmxHelperRequest, JndiHelperRequest } from './jms-jmx-contract.ts'

const HELPER_CLASS = 'WlsJmsJmxHelper'
const HELPER_SOURCE = `${HELPER_CLASS}.java`
const COMPILE_TIMEOUT_MS = 15_000
const INVOKE_TIMEOUT_MS = 30_000

export interface JmsJmxHelperErrorPayload {
  code: string
  message: string
  retryable: boolean
  phase?: string
  diagnostics?: string[]
}

export class JmsJmxInvocationError extends Error {
  readonly code: string
  readonly status: number
  readonly retryable: boolean
  readonly phase: string | null
  readonly diagnostics: string[]

  constructor(
    code: string,
    message: string,
    status = 502,
    retryable = true,
    options: { phase?: string | null; diagnostics?: string[] } = {},
  ) {
    super(message)
    this.name = 'JmsJmxInvocationError'
    this.code = code
    this.status = status
    this.retryable = retryable
    this.phase = options.phase ?? null
    this.diagnostics = options.diagnostics ?? []
  }
}

interface ProcessResult {
  stdout: string
  stderr: string
  status: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
}

function helperSourcePath() {
  const dirname = path.dirname(fileURLToPath(import.meta.url))
  return path.join(dirname, 'java', HELPER_SOURCE)
}

// The compiled helper receives WebLogic credentials on stdin, so it must never be loaded from a
// directory another local user could have prepared: build it in the user's own Cockpit data
// directory, private to the user, keyed by the source content.
export async function helperBuildDir(sourcePath: string, env: NodeJS.ProcessEnv = process.env) {
  const hash = createHash('sha256').update(await readFile(sourcePath)).digest('hex').slice(0, 16)
  const dataDir = env.WLS_COCKPIT_DATA_DIR || path.join(os.homedir(), '.wls-cockpit')
  const cacheRoot = path.join(dataDir, 'jms-jmx-helper')
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
  await chmod(cacheRoot, 0o700)
  return path.join(cacheRoot, hash)
}

async function newerThan(sourcePath: string, classPath: string) {
  try {
    const [source, klass] = await Promise.all([stat(sourcePath), stat(classPath)])
    return source.mtimeMs > klass.mtimeMs
  } catch {
    return true
  }
}

// The WebLogic thin T3 client reflects into java.base; on JDK 17+ the JVM refuses it and the T3
// connection hangs until the helper is killed. JDK_JAVA_OPTIONS is read by JDK 9+ launchers only,
// so a JDK 8 runtime is unaffected (it does not know --add-opens).
export const HELPER_JAVA_OPENS = [
  'java.base/java.io',
  'java.base/java.lang',
  'java.base/java.util',
  'java.base/java.net',
  'java.base/sun.nio.ch',
].map((pkg) => `--add-opens=${pkg}=ALL-UNNAMED`)

export function helperJavaEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const existing = env.JDK_JAVA_OPTIONS?.trim()
  return { ...env, JDK_JAVA_OPTIONS: [existing, ...HELPER_JAVA_OPENS].filter(Boolean).join(' ') }
}

function runProcess(command: string, args: string[], input: string | null, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: helperJavaEnv() })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, status, signal, timedOut })
    })

    // A JVM that exits before reading its input (bad classpath, no memory) makes the write fail
    // with EPIPE; the exit status already reports it, and an unhandled stream error would stop
    // the local server.
    child.stdin.on('error', () => undefined)
    if (input !== null) child.stdin.end(input)
    else child.stdin.end()
  })
}

async function ensureCompiled(config: JmsJmxConfig) {
  const sourcePath = helperSourcePath()
  const buildDir = await helperBuildDir(sourcePath)
  const classPath = path.join(buildDir, `${HELPER_CLASS}.class`)
  await mkdir(buildDir, { recursive: true, mode: 0o700 })

  if (!(await newerThan(sourcePath, classPath))) return buildDir

  try {
    const result = await runProcess(config.javacCommand, ['-encoding', 'UTF-8', '-d', buildDir, sourcePath], null, COMPILE_TIMEOUT_MS)
    if (result.timedOut) {
      throw new JmsJmxInvocationError('JMS_JMX_JAVAC_TIMEOUT', 'Timed out compiling the local JMS JMX helper.', 503, true)
    }
    if (result.status !== 0) {
      throw new JmsJmxInvocationError('JMS_JMX_JAVAC_FAILED', 'Unable to compile the local JMS JMX helper.', 503, false)
    }
    return buildDir
  } catch (error) {
    if (error instanceof JmsJmxInvocationError) throw error
    throw new JmsJmxInvocationError('JMS_JMX_JAVAC_UNAVAILABLE', 'javac is required to prepare the local JMS JMX helper.', 503, false)
  }
}

function helperClasspath(classDir: string, config: JmsJmxConfig) {
  return `${classDir}${path.delimiter}${config.classpath ?? ''}`
}

function parseHelperJson(stdout: string) {
  const text = stdout.trim()
  if (!text) {
    throw new JmsJmxInvocationError('JMS_JMX_EMPTY_RESPONSE', 'The local JMS JMX helper returned no JSON.', 502, true)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new JmsJmxInvocationError('JMS_JMX_BAD_RESPONSE', 'The local JMS JMX helper returned invalid JSON.', 502, true)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function sanitizeHelperDiagnosticLine(line: string) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('WLS_COCKPIT_JMS_JMX ')) return null
  const safe = trimmed
    .replace(/https?:\/\/[^\s]+/g, '<target>')
    .replace(/\b(?:192\.168|10|172\.(?:1[6-9]|2\d|3[0-1]))\.\d{1,3}\.\d{1,3}\b/g, '<target>')
    .replace(/\/(?:Users|u01|oracle|domains|private|var|tmp|opt|home)\/[^\s]+/g, '<path>')
    .replace(/(password|credential|authorization)=[^\s]+/gi, '$1=<redacted>')
    .replace(/[^\w .:=/<>-]/g, '?')
    .slice(0, 240)
  return safe.length ? safe : null
}

export function helperDiagnostics(stderr: string) {
  return stderr
    .split(/\r?\n/)
    .flatMap((line) => {
      const sanitized = sanitizeHelperDiagnosticLine(line)
      return sanitized ? [sanitized] : []
    })
    .slice(-20)
}

export function latestHelperPhase(diagnostics: string[]) {
  for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
    const match = diagnostics[index].match(/\bphase=([A-Za-z0-9_.-]+)/)
    if (match?.[1]) return match[1]
  }
  return null
}

function helperError(value: unknown): JmsJmxHelperErrorPayload | null {
  if (!isObject(value) || !isObject(value.error)) return null
  const code = typeof value.error.code === 'string' ? value.error.code : 'JMS_JMX_HELPER_FAILURE'
  const message = typeof value.error.message === 'string' ? value.error.message : 'The local JMS JMX helper failed.'
  const retryable = typeof value.error.retryable === 'boolean' ? value.error.retryable : true
  const phase = typeof value.error.phase === 'string' ? value.error.phase : undefined
  return { code, message, retryable, phase }
}

export async function invokeJmsJmxHelper(request: JmsJmxHelperRequest | JndiHelperRequest, config = discoverJmsJmxConfig()) {
  if (!config.available || !config.classpath) {
    throw new JmsJmxInvocationError('JMS_JMX_UNAVAILABLE', config.reason ?? 'JMS JMX support is not configured.', 503, false)
  }

  const classDir = await ensureCompiled(config)
  const input = JSON.stringify(request)
  let result: ProcessResult
  try {
    result = await runProcess(config.javaCommand, ['-cp', helperClasspath(classDir, config), HELPER_CLASS], input, INVOKE_TIMEOUT_MS)
  } catch {
    throw new JmsJmxInvocationError('JMS_JMX_JAVA_UNAVAILABLE', 'java is required to run the local JMS JMX helper.', 503, false)
  }

  if (result.timedOut) {
    const diagnostics = helperDiagnostics(result.stderr)
    const phase = latestHelperPhase(diagnostics)
    const phaseSuffix = phase ? ` during JMS JMX phase ${phase}` : ''
    const work = request.operation === 'jndi' ? 'reading the JNDI tree over T3' : 'querying JMS messages over JMX/T3'
    throw new JmsJmxInvocationError(
      'JMS_JMX_TIMEOUT',
      `Timed out${phaseSuffix} while ${work}.`,
      504,
      true,
      { phase, diagnostics },
    )
  }

  const diagnostics = helperDiagnostics(result.stderr)
  const parsed = parseHelperJson(result.stdout)
  const error = helperError(parsed)
  if (error) {
    throw new JmsJmxInvocationError(error.code, error.message, error.retryable ? 502 : 400, error.retryable, {
      phase: error.phase ?? latestHelperPhase(diagnostics),
      diagnostics,
    })
  }

  if (result.status !== 0) {
    throw new JmsJmxInvocationError('JMS_JMX_PROCESS_FAILED', 'The local JMS JMX helper exited unsuccessfully.', 502, true, {
      phase: latestHelperPhase(diagnostics),
      diagnostics,
    })
  }

  return parsed
}

export function jmsJmxErrorResponse(error: unknown): { status: number; body: { error: JmsJmxHelperErrorPayload } } {
  if (error instanceof JmsJmxInvocationError) {
    const detail = {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.phase ? { phase: error.phase } : {}),
      ...(error.diagnostics.length ? { diagnostics: error.diagnostics } : {}),
    }
    return {
      status: error.status,
      body: {
        error: detail,
      },
    }
  }
  return {
    status: 502,
    body: {
      error: {
        code: 'JMS_JMX_UNEXPECTED_FAILURE',
        message: 'Unexpected JMS JMX helper failure.',
        retryable: true,
      },
    },
  }
}
