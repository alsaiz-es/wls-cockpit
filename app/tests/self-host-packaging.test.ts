import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer, request, type IncomingMessage } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { WLS_TARGET_HEADER } from '../src/api/proxy-target.ts'
import { requestCockpitShutdown } from '../src/api/cockpit-shutdown.ts'
import { readRuntimeConfig, resolveRuntimeConfig } from '../src/api/runtime-config.ts'
import { demoReadOnlyModeLabel } from '../src/components/app-shell-mode.ts'
import { browserOpenCommand, browserUrl, isCliEntryPoint, isCockpitListening, parseCliArgs } from '../server/cli.ts'
import { createCockpitServer, MAX_JSON_BODY_BYTES, MAX_PROXY_BODY_BYTES } from '../server/http.ts'
import { writeConnectionProfileCatalog } from '../server/connection-profile-store.ts'
import { assemblePortableRuntime } from '../scripts/package-portable.mjs'

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener')
  return `http://127.0.0.1:${address.port}`
}

async function bodyText(req: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function createPortableFixture(t: TestContext) {
  const appDir = await mkdtemp(path.join(os.tmpdir(), 'wls-cockpit-portable-fixture-'))
  t.after(() => rm(appDir, { recursive: true, force: true }))
  await mkdir(path.join(appDir, 'dist', 'assets'), { recursive: true })
  await mkdir(path.join(appDir, 'dist-server', 'java'), { recursive: true })
  await writeFile(path.join(appDir, 'dist', 'index.html'), '<html></html>')
  await writeFile(path.join(appDir, 'dist', 'assets', 'app.js'), 'console.log("ok")')
  await writeFile(path.join(appDir, 'dist-server', 'wls-cockpit.mjs'), '#!/usr/bin/env node\n')
  await writeFile(path.join(appDir, 'dist-server', 'java', 'WlsJmsJmxHelper.java'), 'class WlsJmsJmxHelper {}\n')
  await writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: 'wls-cockpit', version: '9.9.9' }))
  return appDir
}

test('CLI parses safe startup options and rejects credentials', () => {
  const targetless = parseCliArgs([], {})
  assert.equal(targetless.ok, true)
  if (!targetless.ok) throw new Error(targetless.error)
  assert.equal(targetless.value.targetUrl, undefined)
  assert.equal(targetless.value.host, '127.0.0.1')
  assert.equal(targetless.value.port, 8888)

  const parsed = parseCliArgs(
    ['--target=http://wls-admin.example.com:7001/', '--host=127.0.0.1', '--port=0', '--version=12.2.1.4.0'],
    {},
  )
  assert.equal(parsed.ok, true)
  if (!parsed.ok) throw new Error(parsed.error)
  assert.equal(parsed.value.targetUrl, 'http://wls-admin.example.com:7001')
  assert.equal(parsed.value.host, '127.0.0.1')
  assert.equal(parsed.value.port, 0)
  assert.equal(parsed.value.defaultVersion, '12.2.1.4.0')
  assert.equal(parsed.value.readOnlyDemoMode, false)

  const readonly = parseCliArgs(['--target=http://wls-admin.example.com:7001', '--read-only-demo'], {})
  assert.equal(readonly.ok, true)
  if (!readonly.ok) throw new Error(readonly.error)
  assert.equal(readonly.value.readOnlyDemoMode, true)

  const readonlyFromEnv = parseCliArgs(['--target=http://wls-admin.example.com:7001'], {
    WLS_COCKPIT_READ_ONLY: 'true',
  })
  assert.equal(readonlyFromEnv.ok, true)
  if (!readonlyFromEnv.ok) throw new Error(readonlyFromEnv.error)
  assert.equal(readonlyFromEnv.value.readOnlyDemoMode, true)

  const targetFromEnv = parseCliArgs([], { WLS_COCKPIT_TARGET: 'http://env-wls.example.com:7001/' })
  assert.equal(targetFromEnv.ok, true)
  if (!targetFromEnv.ok) throw new Error(targetFromEnv.error)
  assert.equal(targetFromEnv.value.targetUrl, 'http://env-wls.example.com:7001')

  assert.equal(parseCliArgs(['--target=http://user:pass@wls-admin.example.com:7001'], {}).ok, false)
  assert.equal(parseCliArgs([], { WLS_COCKPIT_TARGET: 'file:///tmp/nope' }).ok, false)
  assert.match(parseCliArgs(['--password=secret'], {}).error, /Password options are not supported/)
})

test('CLI browser opening defaults to auto and honours flags and env', () => {
  const auto = parseCliArgs([], {})
  if (!auto.ok) throw new Error(auto.error)
  assert.equal(auto.value.openBrowser, undefined)

  const forced = parseCliArgs(['--open'], { WLS_COCKPIT_OPEN: '0' })
  if (!forced.ok) throw new Error(forced.error)
  assert.equal(forced.value.openBrowser, true)

  const disabled = parseCliArgs(['--no-open'], {})
  if (!disabled.ok) throw new Error(disabled.error)
  assert.equal(disabled.value.openBrowser, false)

  const fromEnv = parseCliArgs([], { WLS_COCKPIT_OPEN: 'false' })
  if (!fromEnv.ok) throw new Error(fromEnv.error)
  assert.equal(fromEnv.value.openBrowser, false)
})

test('CLI browser URL and open command are platform aware', () => {
  assert.equal(browserUrl('127.0.0.1', 8888), 'http://127.0.0.1:8888')
  assert.equal(browserUrl('0.0.0.0', 8080), 'http://127.0.0.1:8080')
  assert.equal(browserUrl('::1', 8080), 'http://[::1]:8080')
  assert.deepEqual(browserOpenCommand('http://127.0.0.1:8888', 'darwin'), { command: 'open', args: ['http://127.0.0.1:8888'] })
  assert.deepEqual(browserOpenCommand('http://127.0.0.1:8888', 'win32'), {
    command: 'rundll32',
    args: ['url.dll,FileProtocolHandler', 'http://127.0.0.1:8888'],
  })
  assert.deepEqual(browserOpenCommand('http://127.0.0.1:8888', 'linux'), { command: 'xdg-open', args: ['http://127.0.0.1:8888'] })
})

test('single-instance probe recognises a running Cockpit and nothing else', async (t) => {
  const cockpit = createCockpitServer({ defaultVersion: '14.1.2.0.0' })
  const other = createServer((_req, res) => res.end('{"app":"something-else"}'))
  t.after(() => {
    for (const server of [cockpit, other]) {
      server.close()
      server.closeAllConnections()
    }
  })
  assert.equal(await isCockpitListening(await listen(cockpit)), true)
  assert.equal(await isCockpitListening(await listen(other)), false)
})

test('loopback-bound server rejects requests addressed to foreign hostnames (DNS rebinding)', async (t) => {
  const loopback = createCockpitServer({ defaultVersion: '14.1.2.0.0', bindHost: '127.0.0.1' })
  const lan = createCockpitServer({ defaultVersion: '14.1.2.0.0', bindHost: '0.0.0.0' })
  t.after(() => {
    for (const server of [loopback, lan]) {
      server.close()
      server.closeAllConnections()
    }
  })
  const get = (base: string, pathname: string, host: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request(`${base}${pathname}`, { headers: { Host: host } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.once('error', reject)
      req.end()
    })
  const loopbackUrl = await listen(loopback)
  const port = new URL(loopbackUrl).port

  for (const pathname of ['/__wls-cockpit/connection-profiles', '/api/wls/management/weblogic/latest/domainRuntime', '/']) {
    assert.equal(await get(loopbackUrl, pathname, `rebound.example.com:${port}`), 403, pathname)
  }
  assert.equal(await get(loopbackUrl, '/__wls-cockpit/runtime-config', `localhost:${port}`), 200)
  assert.equal(await get(loopbackUrl, '/__wls-cockpit/runtime-config', `127.0.0.1:${port}`), 200)

  // A non-loopback bind is reached by name or LAN address, so Host is not restricted there.
  const lanUrl = await listen(lan)
  assert.equal(await get(lanUrl, '/__wls-cockpit/runtime-config', `cockpit.example.com:${new URL(lanUrl).port}`), 200)
})

test('shutdown endpoint only stops the CLI server for local same-page requests', async (t) => {
  let stops = 0
  const cli = createCockpitServer({ defaultVersion: '14.1.2.0.0', onShutdownRequest: () => (stops += 1) })
  const dev = createCockpitServer({ defaultVersion: '14.1.2.0.0' })
  t.after(() => {
    for (const server of [cli, dev]) {
      server.close()
      server.closeAllConnections()
    }
  })
  const cliUrl = await listen(cli)
  const devUrl = await listen(dev)
  // node:http rather than fetch: fetch does not let a caller override the Host header.
  const shutdown = (base: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number }>((resolve, reject) => {
      const req = request(`${base}/__wls-cockpit/shutdown`, { method: 'POST', headers }, (res) => {
        res.resume()
        resolve({ status: res.statusCode ?? 0 })
      })
      req.once('error', reject)
      req.end()
    })

  const config = await (await fetch(`${cliUrl}/__wls-cockpit/runtime-config`)).json()
  assert.equal(config.shutdownAvailable, true)
  assert.equal((await (await fetch(`${devUrl}/__wls-cockpit/runtime-config`)).json()).shutdownAvailable, false)

  assert.equal((await shutdown(devUrl, { 'X-WLS-Cockpit-Shutdown': 'confirm' })).status, 404)
  assert.equal((await fetch(`${cliUrl}/__wls-cockpit/shutdown`)).status, 405)
  assert.equal((await shutdown(cliUrl)).status, 403)
  assert.equal(
    (await shutdown(cliUrl, { 'X-WLS-Cockpit-Shutdown': 'confirm', Host: `attacker.example.com:${new URL(cliUrl).port}` })).status,
    403,
  )
  assert.equal((await shutdown(cliUrl, { 'X-WLS-Cockpit-Shutdown': 'confirm', Host: 'localhost:1' })).status, 403)
  assert.equal(stops, 0)

  assert.equal((await shutdown(cliUrl, { 'X-WLS-Cockpit-Shutdown': 'confirm' })).status, 202)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(stops, 1)

  // The browser helper sends exactly what the server requires.
  await requestCockpitShutdown(((input: string, init?: RequestInit) =>
    fetch(`${cliUrl}${input}`, init)) as typeof fetch)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(stops, 2)
  await assert.rejects(
    requestCockpitShutdown(((input: string, init?: RequestInit) => fetch(`${devUrl}${input}`, init)) as typeof fetch),
    /HTTP 404/,
  )
})

test('shutdown is accepted from a page opened at a specific non-loopback bind address', async (t) => {
  let stops = 0
  // The Host check only compares names, so the server can listen on loopback for the test.
  const cli = createCockpitServer({ defaultVersion: '14.1.2.0.0', bindHost: '192.0.2.10', onShutdownRequest: () => (stops += 1) })
  t.after(() => {
    cli.close()
    cli.closeAllConnections()
  })
  const cliUrl = await listen(cli)
  const port = new URL(cliUrl).port
  const shutdown = (host: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request(
        `${cliUrl}/__wls-cockpit/shutdown`,
        { method: 'POST', headers: { 'X-WLS-Cockpit-Shutdown': 'confirm', Host: host } },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.once('error', reject)
      req.end()
    })

  assert.equal(await shutdown(`attacker.example.com:${port}`), 403)
  assert.equal(await shutdown('192.0.2.10:1'), 403)
  assert.equal(stops, 0)
  assert.equal(await shutdown(`192.0.2.10:${port}`), 202)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(stops, 1)
})

test('runtime config normalizes server defaults and falls back to safe defaults', () => {
  assert.deepEqual(
    readRuntimeConfig({ defaultTargetUrl: 'http://wls-admin.example.com:7001/', defaultVersion: '12.2.1.4.0' }),
    {
      defaultTargetUrl: 'http://wls-admin.example.com:7001',
      defaultVersion: '12.2.1.4.0',
      readOnlyDemoMode: false,
      jmsJmxAvailable: false,
      jmsJmxUnavailableReason: null,
      actionAuditAvailable: false,
      connectionProfileCatalogAvailable: false,
      shutdownAvailable: false,
      exitWithLastTab: false,
    },
  )
  assert.deepEqual(readRuntimeConfig({ defaultTargetUrl: 'file:///tmp/nope', defaultVersion: 'bad' }), {
    defaultTargetUrl: undefined,
    defaultVersion: '14.1.2.0.0',
    readOnlyDemoMode: false,
    jmsJmxAvailable: false,
    jmsJmxUnavailableReason: null,
    actionAuditAvailable: false,
    connectionProfileCatalogAvailable: false,
    shutdownAvailable: false,
    exitWithLastTab: false,
  })
  assert.deepEqual(readRuntimeConfig({ readOnlyDemoMode: true }), {
    defaultTargetUrl: undefined,
    defaultVersion: '14.1.2.0.0',
    readOnlyDemoMode: true,
    jmsJmxAvailable: false,
    jmsJmxUnavailableReason: null,
    actionAuditAvailable: false,
    connectionProfileCatalogAvailable: false,
    shutdownAvailable: false,
    exitWithLastTab: false,
  })

  assert.deepEqual(
    resolveRuntimeConfig({
      runtime: { defaultVersion: '14.1.2.0.0', readOnlyDemoMode: false },
      env: {
        VITE_WLS_TARGET: 'http://wls-admin.example.com:7001',
        VITE_WLS_COCKPIT_READ_ONLY: 'true',
      },
    }),
    {
      defaultTargetUrl: undefined,
      defaultVersion: '14.1.2.0.0',
      readOnlyDemoMode: false,
      jmsJmxAvailable: false,
      jmsJmxUnavailableReason: null,
      actionAuditAvailable: false,
      connectionProfileCatalogAvailable: false,
      shutdownAvailable: false,
      exitWithLastTab: false,
    },
  )
})

test('demo read-only shell label is only present when enabled', () => {
  assert.equal(demoReadOnlyModeLabel(false), null)
  assert.equal(demoReadOnlyModeLabel(true), 'Demo read-only')
})

test('package file allow-list contains only self-host runtime artifacts', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { files?: string[] }
  assert.deepEqual(packageJson.files, ['dist', 'dist-server', 'scripts/postinstall.mjs', 'README.md'])
})

test('portable Linux assembly copies runtime artifacts and launcher', async (t) => {
  const appDir = await createPortableFixture(t)
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'wls-cockpit-portable-out-'))
  t.after(() => rm(outDir, { recursive: true, force: true }))

  const targetDir = assemblePortableRuntime({ appDir, outDir, platform: 'linux' })
  assert.equal(path.basename(targetDir), 'wls-cockpit-linux-x64')
  assert.equal(await readFile(path.join(targetDir, 'dist', 'index.html'), 'utf8'), '<html></html>')
  assert.match(await readFile(path.join(targetDir, 'start-wls-cockpit.sh'), 'utf8'), /dist-server\/wls-cockpit\.mjs/)
  assert.match(await readFile(path.join(targetDir, 'README.txt'), 'utf8'), /ORACLE_HOME/)
  assert.deepEqual(JSON.parse(await readFile(path.join(targetDir, 'package.json'), 'utf8')), {
    name: 'wls-cockpit',
    version: '9.9.9',
    type: 'module',
    bin: { 'wls-cockpit': './dist-server/wls-cockpit.mjs' },
    engines: { node: '>=20.11' },
  })
  assert.deepEqual(JSON.parse(await readFile(path.join(targetDir, 'portable-manifest.json'), 'utf8')), {
    name: 'wls-cockpit',
    version: '9.9.9',
    platform: 'linux',
    arch: 'x64',
    nodeRuntimeBundled: false,
    entrypoint: 'dist-server/wls-cockpit.mjs',
  })
  assert.equal((await stat(path.join(targetDir, 'start-wls-cockpit.sh'))).mode & 0o111, 0o111)
})

test('portable macOS assembly copies runtime artifacts and launcher', async (t) => {
  const appDir = await createPortableFixture(t)
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'wls-cockpit-portable-out-'))
  const nodeRuntimeDir = await mkdtemp(path.join(os.tmpdir(), 'wls-cockpit-node-runtime-'))
  t.after(() => rm(outDir, { recursive: true, force: true }))
  t.after(() => rm(nodeRuntimeDir, { recursive: true, force: true }))
  await mkdir(path.join(nodeRuntimeDir, 'bin'))
  await writeFile(path.join(nodeRuntimeDir, 'bin', 'node'), '')

  const targetDir = assemblePortableRuntime({ appDir, outDir, platform: 'macos', arch: 'arm64', nodeRuntimeDir })
  assert.equal(path.basename(targetDir), 'wls-cockpit-macos-arm64')
  assert.equal(await readFile(path.join(targetDir, 'node', 'bin', 'node'), 'utf8'), '')
  assert.match(await readFile(path.join(targetDir, 'start-wls-cockpit.sh'), 'utf8'), /node\/bin\/node/)
  assert.deepEqual(JSON.parse(await readFile(path.join(targetDir, 'portable-manifest.json'), 'utf8')), {
    name: 'wls-cockpit',
    version: '9.9.9',
    platform: 'macos',
    arch: 'arm64',
    nodeRuntimeBundled: true,
    entrypoint: 'dist-server/wls-cockpit.mjs',
  })
  assert.equal((await stat(path.join(targetDir, 'start-wls-cockpit.sh'))).mode & 0o111, 0o111)
  const doubleClick = path.join(targetDir, 'WLS Cockpit.command')
  assert.match(await readFile(doubleClick, 'utf8'), /\.\/start-wls-cockpit\.sh --host=127\.0\.0\.1 --port=8888 --open "\$@"/)
  assert.equal((await stat(doubleClick)).mode & 0o111, 0o111)
  assert.match(await readFile(path.join(targetDir, 'README.txt'), 'utf8'), /WLS Cockpit\.command/)
})

test('portable Windows assembly requires and copies supplied Node runtime', async (t) => {
  const appDir = await createPortableFixture(t)
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'wls-cockpit-portable-out-'))
  const nodeRuntimeDir = await mkdtemp(path.join(os.tmpdir(), 'wls-cockpit-node-runtime-'))
  t.after(() => rm(outDir, { recursive: true, force: true }))
  t.after(() => rm(nodeRuntimeDir, { recursive: true, force: true }))
  await writeFile(path.join(nodeRuntimeDir, 'node.exe'), '')

  assert.throws(
    () => assemblePortableRuntime({ appDir, outDir, platform: 'windows' }),
    /requires --node-runtime-dir/,
  )

  const targetDir = assemblePortableRuntime({ appDir, outDir, platform: 'windows', nodeRuntimeDir })
  assert.equal(path.basename(targetDir), 'wls-cockpit-windows-x64')
  assert.equal(await readFile(path.join(targetDir, 'node', 'node.exe'), 'utf8'), '')
  const launcher = await readFile(path.join(targetDir, 'start-wls-cockpit.cmd'), 'utf8')
  assert.match(launcher, /node\\node\.exe/)
  assert.match(launcher, /set "COCKPIT_PORT=8888"/)
  assert.match(launcher, /set "WLS_COCKPIT_TARGET="/)
  assert.doesNotMatch(launcher, /timeout \/t/)
  assert.match(launcher, /if "%EXIT_CODE%"=="0" endlocal & exit \/b 0/)
  assert.match(launcher, /dist-server\\wls-cockpit\.mjs" --host=%COCKPIT_HOST% --port=%COCKPIT_PORT% --open %\*/)
  assert.match(launcher, /pause >NUL/)
  assert.match(await readFile(path.join(targetDir, 'README.txt'), 'utf8'), /Double-click start-wls-cockpit\.cmd/)

  // With the native launcher, it is the documented double-click entry point; the .cmd stays.
  const exe = path.join(nodeRuntimeDir, 'launcher.exe')
  await writeFile(exe, 'MZ')
  const withLauncher = assemblePortableRuntime({ appDir, outDir, platform: 'windows', nodeRuntimeDir, windowsLauncher: exe })
  assert.equal(await readFile(path.join(withLauncher, 'WLS Cockpit.exe'), 'utf8'), 'MZ')
  assert.ok(await readFile(path.join(withLauncher, 'start-wls-cockpit.cmd'), 'utf8'))
  const readme = await readFile(path.join(withLauncher, 'README.txt'), 'utf8')
  assert.match(readme, /Double-click "WLS Cockpit\.exe"/)
  assert.match(readme, /SmartScreen/)
})

test('portable assembly rejects missing production build artifacts', async (t) => {
  const appDir = await mkdtemp(path.join(os.tmpdir(), 'wls-cockpit-portable-bad-'))
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'wls-cockpit-portable-out-'))
  t.after(() => rm(appDir, { recursive: true, force: true }))
  t.after(() => rm(outDir, { recursive: true, force: true }))

  assert.throws(() => assemblePortableRuntime({ appDir, outDir, platform: 'linux' }), /Missing production UI build/)
})

test('self-hosted server serves static app with injected runtime config', async (t) => {
  const distDir = await mkdtemp(path.join(os.tmpdir(), 'wls-cockpit-dist-'))
  await mkdir(path.join(distDir, 'assets'))
  await writeFile(path.join(distDir, 'index.html'), '<html><head></head><body><div id="root"></div></body></html>')
  await writeFile(path.join(distDir, 'assets', 'app.js'), 'console.log("ok")')

  const server = createCockpitServer({
    targetUrl: 'http://wls-admin.example.com:7001',
    defaultVersion: '12.2.1.4.0',
    readOnlyDemoMode: true,
    distDir,
  })
  t.after(() => server.close())
  const baseUrl = await listen(server)

  const index = await fetch(`${baseUrl}/servers`)
  const html = await index.text()
  assert.equal(index.status, 200)
  assert.match(html, /window\.__WLS_COCKPIT_RUNTIME__/)
  assert.match(html, /http:\/\/wls-admin\.example\.com:7001/)

  const runtime = await fetch(`${baseUrl}/__wls-cockpit/runtime-config`)
  assert.deepEqual(await runtime.json(), {
    app: 'wls-cockpit',
    defaultTargetUrl: 'http://wls-admin.example.com:7001',
    defaultVersion: '12.2.1.4.0',
    readOnlyDemoMode: true,
    jmsJmxAvailable: false,
    jmsJmxUnavailableReason:
      'JMS message browsing requires WLS_COCKPIT_WLS_CLIENT_CLASSPATH, WLS_COCKPIT_WL_HOME, WL_HOME, or ORACLE_HOME with a local wlthint3client.jar on the Cockpit host.',
    actionAuditAvailable: true,
    connectionProfileCatalogAvailable: true,
    shutdownAvailable: false,
    exitWithLastTab: false,
  })
})

test('self-hosted server can start without an injected default target', async (t) => {
  const distDir = await mkdtemp(path.join(os.tmpdir(), 'wls-cockpit-dist-'))
  await writeFile(path.join(distDir, 'index.html'), '<html><head></head><body><div id="root"></div></body></html>')

  const server = createCockpitServer({
    defaultVersion: '14.1.2.0.0',
    distDir,
  })
  t.after(() => server.close())
  const baseUrl = await listen(server)

  const runtime = await fetch(`${baseUrl}/__wls-cockpit/runtime-config`)
  const payload = (await runtime.json()) as Record<string, unknown>
  assert.equal(runtime.status, 200)
  assert.equal('defaultTargetUrl' in payload, false)
  assert.equal(payload.defaultVersion, '14.1.2.0.0')
  assert.equal(payload.connectionProfileCatalogAvailable, true)
})

test('self-hosted connection profile catalog persists outside browser origin storage', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wls-cockpit-profile-data-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))

  const cockpit = createCockpitServer({
    defaultVersion: '14.1.2.0.0',
    connectionProfileStore: { dataDir },
  })
  t.after(() => cockpit.close())
  const cockpitUrl = await listen(cockpit)

  const saved = await fetch(`${cockpitUrl}/__wls-cockpit/connection-profiles`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      profiles: [
        {
          id: 'profile-a',
          name: 'Remote lab',
          targetUrl: 'http://wls-admin.example.com:7001',
          version: '14.1.2.0.0',
          username: 'admin',
          password: 'must-not-persist',
        },
        {
          id: 'bad',
          name: 'Bad path',
          targetUrl: 'http://wls-admin.example.com:7001/console',
          version: '14.1.2.0.0',
        },
      ],
    }),
  })
  assert.equal(saved.status, 200)
  assert.deepEqual(await saved.json(), {
    profiles: [
      {
        id: 'profile-a',
        name: 'Remote lab',
        targetUrl: 'http://wls-admin.example.com:7001',
        version: '14.1.2.0.0',
        username: 'admin',
      },
    ],
  })

  const loaded = await fetch(`${cockpitUrl}/__wls-cockpit/connection-profiles`)
  assert.equal(loaded.status, 200)
  assert.deepEqual(await loaded.json(), {
    profiles: [
      {
        id: 'profile-a',
        name: 'Remote lab',
        targetUrl: 'http://wls-admin.example.com:7001',
        version: '14.1.2.0.0',
        username: 'admin',
      },
    ],
  })

  const stored = await readFile(path.join(dataDir, 'connection-profiles.json'), 'utf8')
  assert.doesNotMatch(stored, /must-not-persist|password/i)
})

test('concurrent profile catalog writes each use their own temp file', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wls-cockpit-profiles-race-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const profile = (name: string) => [
    { id: 'profile-a', name, targetUrl: 'http://wls-admin.example.com:7001', version: '14.1.2.0.0' },
  ]

  // Two tabs saving in the same millisecond used to share one temp path: the second rename
  // failed with ENOENT, or the catalog got the other tab's half-written body.
  const writes = await Promise.allSettled(
    Array.from({ length: 20 }, (_, index) => writeConnectionProfileCatalog(profile(`Lab ${index}`), { dataDir })),
  )
  assert.deepEqual(writes.filter((result) => result.status === 'rejected'), [])
  const stored = JSON.parse(await readFile(path.join(dataDir, 'connection-profiles.json'), 'utf8')) as {
    profiles: Array<{ name: string }>
  }
  assert.match(stored.profiles[0]?.name ?? '', /^Lab \d+$/)
})

test('oversized request bodies are refused with 413 before reaching WebLogic', async (t) => {
  let upstreamCalls = 0
  const upstream = createServer((_req, res) => {
    upstreamCalls += 1
    res.end('{}')
  })
  t.after(() => {
    upstream.closeAllConnections()
    upstream.close()
  })
  const upstreamUrl = await listen(upstream)
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wls-cockpit-body-limit-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const cockpit = createCockpitServer({
    targetUrl: upstreamUrl,
    defaultVersion: '14.1.2.0.0',
    connectionProfileStore: { dataDir },
  })
  t.after(() => {
    cockpit.closeAllConnections()
    cockpit.close()
  })
  const cockpitUrl = await listen(cockpit)

  const declaredTooLarge = (pathname: string, limit: number, method: string, extraHeaders: Record<string, string> = {}) =>
    new Promise<number>((resolve, reject) => {
      const client = request(`${cockpitUrl}${pathname}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(limit + 1), ...extraHeaders },
      })
      client.on('response', (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
        client.destroy()
      })
      client.on('error', reject)
      client.write('{')
    })

  assert.equal(
    await declaredTooLarge('/api/wls/management/weblogic/latest/edit/servers', MAX_PROXY_BODY_BYTES, 'POST', {
      [WLS_TARGET_HEADER]: upstreamUrl,
    }),
    413,
  )
  assert.equal(upstreamCalls, 0)
  assert.equal(await declaredTooLarge('/__wls-cockpit/connection-profiles', MAX_JSON_BODY_BYTES, 'PUT'), 413)

  const small = await fetch(`${cockpitUrl}/api/wls/management/weblogic/latest/domainRuntime`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [WLS_TARGET_HEADER]: upstreamUrl },
    body: '{}',
  })
  assert.equal(small.status, 200)
})

test('the CLI runs when started through the npm bin symlink', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wls-cockpit-bin-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const bundle = path.join(dir, 'dist-server', 'wls-cockpit.mjs')
  await mkdir(path.dirname(bundle), { recursive: true })
  await writeFile(bundle, '')
  await mkdir(path.join(dir, '.bin'))
  const bin = path.join(dir, '.bin', 'wls-cockpit')
  if (process.platform !== 'win32') await symlink(bundle, bin)

  // npx and global installs run node_modules/.bin/wls-cockpit, a symlink without the .mjs name;
  // matching on the file name made the CLI exit silently with status 0.
  if (process.platform !== 'win32') assert.equal(isCliEntryPoint(bin, pathToFileURL(bundle).href), true)
  assert.equal(isCliEntryPoint(bundle, pathToFileURL(bundle).href), true)
  assert.equal(isCliEntryPoint(path.join(dir, 'other.mjs'), pathToFileURL(bundle).href), false)
  assert.equal(isCliEntryPoint(undefined, pathToFileURL(bundle).href), false)
})

test('a malformed static path is a 400, not a 502', async (t) => {
  const distDir = await mkdtemp(path.join(os.tmpdir(), 'wls-cockpit-static-'))
  t.after(() => rm(distDir, { recursive: true, force: true }))
  await writeFile(path.join(distDir, 'index.html'), '<html><head></head></html>')
  const cockpit = createCockpitServer({ distDir, connectionProfileStore: { enabled: false } })
  t.after(() => {
    cockpit.closeAllConnections()
    cockpit.close()
  })
  const cockpitUrl = await listen(cockpit)
  const response = await fetch(`${cockpitUrl}/assets/%E0%A4%A`)
  assert.equal(response.status, 400)
})

test('self-hosted proxy rewrites paths and strips local target metadata', async (t) => {
  let upstreamCalls = 0
  let capturedUrl = ''
  let capturedAuth = ''
  let capturedTargetHeader = ''
  let capturedProfileHeader = ''
  let capturedBody = ''

  const upstream = createServer((req, res) => {
    void (async () => {
      upstreamCalls += 1
      capturedUrl = req.url ?? ''
      capturedAuth = req.headers.authorization ?? ''
      capturedTargetHeader = req.headers[WLS_TARGET_HEADER.toLowerCase()]?.toString() ?? ''
      capturedProfileHeader = req.headers['x-wls-cockpit-profile-id']?.toString() ?? ''
      capturedBody = await bodyText(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })()
  })
  t.after(() => upstream.close())
  const upstreamUrl = await listen(upstream)

  const cockpit = createCockpitServer({
    targetUrl: 'http://fallback.example.com:7001',
    defaultVersion: '14.1.2.0.0',
  })
  t.after(() => cockpit.close())
  const cockpitUrl = await listen(cockpit)

  const proxied = await fetch(`${cockpitUrl}/api/wls/management/weblogic/latest/domainRuntime?links=none`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic abc123',
      'Content-Type': 'application/json',
      [WLS_TARGET_HEADER]: upstreamUrl,
      'x-wls-cockpit-profile-id': 'profile-a',
    },
    body: JSON.stringify({ fields: ['name'] }),
  })

  assert.equal(proxied.status, 200)
  assert.equal(capturedUrl, '/management/weblogic/latest/domainRuntime?links=none')
  assert.equal(capturedAuth, 'Basic abc123')
  assert.equal(capturedTargetHeader, '')
  assert.equal(capturedProfileHeader, '')
  assert.equal(capturedBody, JSON.stringify({ fields: ['name'] }))

  const blocked = await fetch(`${cockpitUrl}/api/wls/management/weblogic/latest/domainRuntime`, {
    headers: { [WLS_TARGET_HEADER]: `${upstreamUrl}/` },
  })
  assert.equal(blocked.status, 400)
  assert.equal(upstreamCalls, 1)
})

test('self-hosted proxy rejects missing target when no startup default exists', async (t) => {
  let upstreamCalls = 0
  const upstream = createServer((_req, res) => {
    upstreamCalls += 1
    res.end(JSON.stringify({ ok: true }))
  })
  t.after(() => upstream.close())
  await listen(upstream)

  const cockpit = createCockpitServer({
    defaultVersion: '14.1.2.0.0',
  })
  t.after(() => cockpit.close())
  const cockpitUrl = await listen(cockpit)

  const blocked = await fetch(`${cockpitUrl}/api/wls/management/weblogic/latest/domainRuntime`)
  assert.equal(blocked.status, 400)
  assert.match(JSON.stringify(await blocked.json()), /Target URL is required/)
  assert.equal(upstreamCalls, 0)
})

test('self-hosted proxy strips upstream content encoding after materializing body', async (t) => {
  const upstream = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Encoding', 'gzip')
    res.end(gzipSync(JSON.stringify({ ok: true })))
  })
  t.after(() => upstream.close())
  const upstreamUrl = await listen(upstream)

  const cockpit = createCockpitServer({
    targetUrl: upstreamUrl,
    defaultVersion: '12.2.1.4.0',
  })
  t.after(() => cockpit.close())
  const cockpitUrl = await listen(cockpit)

  const proxied = await fetch(`${cockpitUrl}/api/wls/management/weblogic/latest/domainRuntime`)

  assert.equal(proxied.status, 200)
  assert.equal(proxied.headers.get('content-encoding'), null)
  assert.deepEqual(await proxied.json(), { ok: true })
})

test('self-hosted proxy does not forward upstream auth challenge headers', async (t) => {
  const upstream = createServer((_req, res) => {
    res.statusCode = 401
    res.statusMessage = 'Unauthorized'
    res.setHeader('Content-Type', 'text/plain')
    res.setHeader('WWW-Authenticate', 'Basic realm="weblogic"')
    res.end('no')
  })
  t.after(() => upstream.close())
  const upstreamUrl = await listen(upstream)

  const cockpit = createCockpitServer({
    targetUrl: upstreamUrl,
    defaultVersion: '14.1.2.0.0',
  })
  t.after(() => cockpit.close())
  const cockpitUrl = await listen(cockpit)

  const proxied = await fetch(`${cockpitUrl}/api/wls/management/weblogic/latest/domainRuntime`, {
    headers: { Authorization: 'Basic bad' },
  })

  assert.equal(proxied.status, 401)
  assert.equal(proxied.headers.get('www-authenticate'), null)
  assert.equal(await proxied.text(), 'no')
})

test('local JMS endpoints validate target, JMX availability, and read-only delete safety before helper invocation', async (t) => {
  const cockpit = createCockpitServer({
    targetUrl: 'http://fallback.example.com:7001',
    defaultVersion: '14.1.2.0.0',
    readOnlyDemoMode: true,
    jmsJmxConfig: {
      available: false,
      classpath: null,
      javaCommand: 'java',
      javacCommand: 'javac',
      reason: 'missing local classpath',
    },
  })
  t.after(() => cockpit.close())
  const cockpitUrl = await listen(cockpit)
  const auth = `Basic ${Buffer.from('admin:unit-test-pass').toString('base64')}`

  const badTarget = await fetch(`${cockpitUrl}/api/jms/messages`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      [WLS_TARGET_HEADER]: 'http://wls-admin.example.com:7001/',
    },
    body: JSON.stringify({ serverName: 'AdminServer', jmsServerName: 'JMSServer', destinationName: 'Queue' }),
  })
  assert.equal(badTarget.status, 400)

  const unavailable = await fetch(`${cockpitUrl}/api/jms/messages`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      [WLS_TARGET_HEADER]: 'http://wls-admin.example.com:7001',
    },
    body: JSON.stringify({ serverName: 'AdminServer', jmsServerName: 'JMSServer', destinationName: 'Queue' }),
  })
  assert.equal(unavailable.status, 503)
  assert.match(JSON.stringify(await unavailable.json()), /missing local classpath/)

  const detailUnavailable = await fetch(`${cockpitUrl}/api/jms/messages/detail`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      [WLS_TARGET_HEADER]: 'http://wls-admin.example.com:7001',
    },
    body: JSON.stringify({ serverName: 'AdminServer', jmsServerName: 'JMSServer', destinationName: 'Queue', messageId: 'ID:1' }),
  })
  assert.equal(detailUnavailable.status, 503)

  const readonlyDelete = await fetch(`${cockpitUrl}/api/jms/messages/delete`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      [WLS_TARGET_HEADER]: 'http://wls-admin.example.com:7001',
    },
    body: JSON.stringify({ serverName: 'AdminServer', jmsServerName: 'JMSServer', destinationName: 'Queue', messageId: 'ID:1' }),
  })
  assert.equal(readonlyDelete.status, 403)

  const readonlyProduce = await fetch(`${cockpitUrl}/api/jms/messages/produce`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      [WLS_TARGET_HEADER]: 'http://wls-admin.example.com:7001',
    },
    body: JSON.stringify({ serverName: 'AdminServer', jmsServerName: 'JMSServer', destinationName: 'Queue', body: 'hello' }),
  })
  assert.equal(readonlyProduce.status, 403)
})

test('local JMS endpoints reject missing target when no startup default exists', async (t) => {
  const cockpit = createCockpitServer({
    defaultVersion: '14.1.2.0.0',
    jmsJmxConfig: {
      available: true,
      classpath: '/opt/wls/client.jar',
      javaCommand: 'java',
      javacCommand: 'javac',
      reason: null,
    },
  })
  t.after(() => cockpit.close())
  const cockpitUrl = await listen(cockpit)

  const blocked = await fetch(`${cockpitUrl}/api/jms/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from('admin:unit-test-pass').toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ serverName: 'AdminServer', jmsServerName: 'JMSServer', destinationName: 'Queue' }),
  })
  assert.equal(blocked.status, 400)
  assert.match(JSON.stringify(await blocked.json()), /Target URL is required/)
})

test('local JMS producer rejects direct non-queue and oversized requests before helper invocation', async (t) => {
  const cockpit = createCockpitServer({
    targetUrl: 'http://wls-admin.example.com:7001',
    defaultVersion: '14.1.2.0.0',
    jmsJmxConfig: {
      available: true,
      classpath: '/opt/wls/client.jar',
      javaCommand: 'java',
      javacCommand: 'javac',
      reason: null,
    },
  })
  t.after(() => cockpit.close())
  const cockpitUrl = await listen(cockpit)
  const auth = `Basic ${Buffer.from('admin:unit-test-pass').toString('base64')}`
  const headers = {
    Authorization: auth,
    'Content-Type': 'application/json',
    [WLS_TARGET_HEADER]: 'http://wls-admin.example.com:7001',
  }

  const topic = await fetch(`${cockpitUrl}/api/jms/messages/produce`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      serverName: 'AdminServer',
      jmsServerName: 'JMSServer',
      destinationName: 'Topic',
      destinationType: 'Topic',
      body: 'hello',
    }),
  })
  assert.equal(topic.status, 400)
  assert.match(JSON.stringify(await topic.json()), /queue destinations/)

  const oversized = await fetch(`${cockpitUrl}/api/jms/messages/produce`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      serverName: 'AdminServer',
      jmsServerName: 'JMSServer',
      destinationName: 'Queue',
      destinationType: 'Queue',
      body: 'hello',
      correlationId: 'x'.repeat(257),
    }),
  })
  assert.equal(oversized.status, 400)
  const payload = JSON.stringify(await oversized.json())
  assert.doesNotMatch(payload, /unit-test-pass|wls-admin|hello/)
})
