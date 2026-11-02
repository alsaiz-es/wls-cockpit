import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import type { Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { normalizeWlsTarget } from '../src/api/proxy-target.ts'
import { defaultWlsVersion, isWlsVersion, type WlsVersion } from '../src/api/wls-version.ts'
import { COCKPIT_APP_ID, createCockpitServer } from './http.ts'

export interface CliOptions {
  targetUrl?: string
  host: string
  port: number
  defaultVersion: WlsVersion
  readOnlyDemoMode: boolean
  // undefined = open the browser only when started from an interactive terminal.
  openBrowser?: boolean
}

export type CliParseResult =
  | { ok: true; value: CliOptions }
  | { ok: false; error: string; help?: boolean }

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8080

function readOption(args: string[], index: number) {
  const arg = args[index]
  const equals = arg.indexOf('=')
  if (equals > -1) return { name: arg.slice(0, equals), value: arg.slice(equals + 1), consumed: 1 }
  return { name: arg, value: args[index + 1], consumed: 2 }
}

function parsePort(value: string | undefined) {
  const port = Number(value)
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null
}

function parseBooleanFlag(value: string | undefined) {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function parseOptionalBooleanFlag(value: string | undefined) {
  if (!value || !value.trim()) return undefined
  return parseBooleanFlag(value)
}

export function parseCliArgs(args: string[], env: Record<string, string | undefined> = process.env): CliParseResult {
  const parsed: Partial<CliOptions> = {
    host: env.WLS_COCKPIT_HOST || DEFAULT_HOST,
    port: parsePort(env.WLS_COCKPIT_PORT) ?? DEFAULT_PORT,
    defaultVersion: defaultWlsVersion(env.WLS_COCKPIT_VERSION),
    readOnlyDemoMode: parseBooleanFlag(env.WLS_COCKPIT_READ_ONLY),
    openBrowser: parseOptionalBooleanFlag(env.WLS_COCKPIT_OPEN),
  }

  for (let index = 0; index < args.length; ) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') return { ok: false, help: true, error: helpText() }
    if (arg === '--password' || arg.startsWith('--password=')) {
      return { ok: false, error: 'Password options are not supported. Enter credentials in the browser session.' }
    }
    if (arg === '--username' || arg.startsWith('--username=') || arg === '--user' || arg.startsWith('--user=')) {
      return { ok: false, error: 'Username options are not supported. Enter credentials in the browser session.' }
    }

    if (arg === '--target' || arg.startsWith('--target=')) {
      const option = readOption(args, index)
      if (!option.value) return { ok: false, error: '--target requires a value.' }
      const target = normalizeWlsTarget(option.value)
      if (!target.ok) return { ok: false, error: target.error }
      parsed.targetUrl = target.targetUrl
      index += option.consumed
      continue
    }

    if (arg === '--host' || arg.startsWith('--host=')) {
      const option = readOption(args, index)
      if (!option.value) return { ok: false, error: '--host requires a value.' }
      parsed.host = option.value
      index += option.consumed
      continue
    }

    if (arg === '--port' || arg.startsWith('--port=')) {
      const option = readOption(args, index)
      const port = parsePort(option.value)
      if (port === null) return { ok: false, error: '--port must be an integer between 0 and 65535.' }
      parsed.port = port
      index += option.consumed
      continue
    }

    if (arg === '--version' || arg.startsWith('--version=')) {
      const option = readOption(args, index)
      if (!isWlsVersion(option.value)) return { ok: false, error: '--version must be a supported WLS REST version.' }
      parsed.defaultVersion = option.value
      index += option.consumed
      continue
    }

    if (arg === '--read-only-demo') {
      parsed.readOnlyDemoMode = true
      index += 1
      continue
    }

    if (arg === '--open' || arg === '--no-open') {
      parsed.openBrowser = arg === '--open'
      index += 1
      continue
    }

    return { ok: false, error: `Unknown option: ${arg}` }
  }

  if (!parsed.targetUrl && env.WLS_COCKPIT_TARGET) {
    const target = normalizeWlsTarget(env.WLS_COCKPIT_TARGET)
    if (!target.ok) return { ok: false, error: target.error }
    parsed.targetUrl = target.targetUrl
  }

  return {
    ok: true,
    value: {
      targetUrl: parsed.targetUrl,
      host: parsed.host ?? DEFAULT_HOST,
      port: parsed.port ?? DEFAULT_PORT,
      defaultVersion: parsed.defaultVersion ?? '14.1.2.0.0',
      readOnlyDemoMode: parsed.readOnlyDemoMode ?? false,
      ...(parsed.openBrowser === undefined ? {} : { openBrowser: parsed.openBrowser }),
    },
  }
}

export function helpText() {
  return [
    'Usage: wls-cockpit [--target=http://wls-admin.example.com:7001] [--host=127.0.0.1] [--port=8080]',
    '',
    'Options:',
    '  --target   Optional WebLogic AdminServer origin for first-run defaults. Credentials, paths, queries, and fragments are rejected.',
    '  --host     Local bind host. Defaults to 127.0.0.1.',
    '  --port     Local bind port. Defaults to 8080. Use 0 for an ephemeral port.',
    '  --version  Default WLS REST version for initial profile seeding.',
    '  --read-only-demo  Hide mutation affordances and mask sensitive display values.',
    '  --open / --no-open  Open Cockpit in the default browser once it is listening. Defaults to',
    '             opening only when started from an interactive terminal (env WLS_COCKPIT_OPEN=0|1).',
    '',
    'If Cockpit is already running on the chosen port, the browser is pointed at it instead.',
    'Stop Cockpit with Ctrl+C or with Quit in the app header.',
    'Credentials are entered in the browser login form and are never accepted as CLI options.',
  ].join('\n')
}

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]'])

// URL a local browser can reach: wildcard binds are reached through loopback.
export function browserUrl(host: string, port: number) {
  const reachable = WILDCARD_HOSTS.has(host) ? '127.0.0.1' : host
  const formatted = reachable.includes(':') && !reachable.startsWith('[') ? `[${reachable}]` : reachable
  return `http://${formatted}:${port}`
}

export function browserOpenCommand(url: string, platform: NodeJS.Platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  // rundll32 avoids cmd.exe's quoting rules for `start "" <url>`.
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
  return { command: 'xdg-open', args: [url] }
}

function openInBrowser(url: string) {
  const { command, args } = browserOpenCommand(url)
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', () => console.log(`Open ${url} in your browser.`))
    child.unref()
  } catch {
    console.log(`Open ${url} in your browser.`)
  }
}

export async function isCockpitListening(url: string, timeoutMs = 2000) {
  try {
    const response = await fetch(`${url}/__wls-cockpit/runtime-config`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return false
    const body = (await response.json()) as { app?: unknown }
    return body.app === COCKPIT_APP_ID
  } catch {
    return false
  }
}

function listen(server: Server, port: number, host: string) {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function stopServer(server: Server) {
  console.log('WLS Cockpit stopped from the browser.')
  // Keep-alive browser connections would otherwise hold close() open indefinitely.
  setTimeout(() => process.exit(0), 2000).unref()
  server.close(() => process.exit(0))
  server.closeAllConnections()
}

export async function runCli(args = process.argv.slice(2), env = process.env) {
  const result = parseCliArgs(args, env)
  if (!result.ok) {
    if (result.help) {
      console.log(result.error)
      return 0
    }
    console.error(result.error)
    return 1
  }

  const { host } = result.value
  const shouldOpen = result.value.openBrowser ?? Boolean(process.stdout.isTTY)
  const server: Server = createCockpitServer({
    targetUrl: result.value.targetUrl,
    defaultVersion: result.value.defaultVersion,
    readOnlyDemoMode: result.value.readOnlyDemoMode,
    onShutdownRequest: () => stopServer(server),
    bindHost: host,
  })

  try {
    await listen(server, result.value.port, host)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    const existingUrl = browserUrl(host, result.value.port)
    if (await isCockpitListening(existingUrl)) {
      console.log(`WLS Cockpit is already running at ${existingUrl}`)
      if (shouldOpen) openInBrowser(existingUrl)
      return 0
    }
    console.error(`Port ${result.value.port} on ${host} is in use by another program. Choose another one with --port.`)
    return 1
  }

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : result.value.port
  const url = browserUrl(host, port)
  console.log(`WLS Cockpit listening at ${url}`)
  if (result.value.targetUrl) console.log(`Default proxy target: ${result.value.targetUrl}`)
  else console.log('Default proxy target: none; create or select a browser profile before connecting.')
  console.log('Stop it with Ctrl+C or with Quit in the app header.')
  if (shouldOpen) openInBrowser(url)
  return 0
}

// npm and npx start the CLI through a symlink (node_modules/.bin/wls-cockpit), so the entry
// point is compared by real path, not by file name.
export function isCliEntryPoint(entry: string | undefined, moduleUrl: string) {
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

if (isCliEntryPoint(process.argv[1], import.meta.url)) {
  runCli().then((code) => {
    if (code !== 0) process.exitCode = code
  })
}
