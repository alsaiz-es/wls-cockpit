#!/usr/bin/env node
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_OUT_DIR = path.join(DEFAULT_APP_DIR, 'portable')

function readPackageMetadata(appDir) {
  const packageJson = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8'))
  return {
    name: typeof packageJson.name === 'string' ? packageJson.name : 'wls-cockpit',
    version: typeof packageJson.version === 'string' ? packageJson.version : '0.0.0',
    engines: packageJson.engines && typeof packageJson.engines === 'object' ? packageJson.engines : { node: '>=20.11' },
  }
}

function parseArgs(args) {
  const options = {
    platform: 'current',
    arch: process.env.WLS_COCKPIT_PORTABLE_ARCH,
    outDir: DEFAULT_OUT_DIR,
    nodeRuntimeDir: process.env.WLS_COCKPIT_NODE_RUNTIME_DIR,
    windowsLauncher: undefined,
  }

  for (const arg of args) {
    if (arg.startsWith('--platform=')) {
      options.platform = arg.slice('--platform='.length)
    } else if (arg.startsWith('--arch=')) {
      options.arch = arg.slice('--arch='.length)
    } else if (arg.startsWith('--out-dir=')) {
      options.outDir = path.resolve(arg.slice('--out-dir='.length))
    } else if (arg.startsWith('--node-runtime-dir=')) {
      options.nodeRuntimeDir = path.resolve(arg.slice('--node-runtime-dir='.length))
    } else if (arg.startsWith('--windows-launcher=')) {
      options.windowsLauncher = path.resolve(arg.slice('--windows-launcher='.length))
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }

  return options
}

function helpText() {
  return [
    'Usage: node scripts/package-portable.mjs [--platform=linux|macos|windows|current] [--arch=x64|arm64] [--out-dir=portable]',
    '',
    'Options:',
    '  --platform          Portable launcher target. Defaults to current.',
    '  --arch              Portable runtime architecture. Defaults to current arch for the current platform, otherwise x64.',
    '  --out-dir           Directory that receives the portable folder. Defaults to app/portable.',
    '  --node-runtime-dir  Optional Node runtime directory to copy into the portable folder.',
    '  --windows-launcher  WLS Cockpit.exe built by scripts/build-windows-launcher.mjs (Windows only).',
    '',
    'Windows portable assembly requires --node-runtime-dir or WLS_COCKPIT_NODE_RUNTIME_DIR.',
  ].join('\n')
}

function currentPortablePlatform() {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'macos'
  return 'linux'
}

function normalizePlatform(value) {
  const normalized = value.toLowerCase()
  if (normalized === 'current') return currentPortablePlatform()
  if (normalized === 'win32' || normalized === 'windows') return 'windows'
  if (normalized === 'darwin' || normalized === 'mac' || normalized === 'macos') return 'macos'
  if (normalized === 'linux') return 'linux'
  throw new Error('--platform must be linux, macos, windows, or current.')
}

function normalizeArch(value) {
  const normalized = value.toLowerCase()
  if (normalized === 'x64' || normalized === 'x86_64' || normalized === 'amd64') return 'x64'
  if (normalized === 'arm64' || normalized === 'aarch64') return 'arm64'
  throw new Error('--arch must be x64 or arm64.')
}

function defaultArchForPlatform(platform) {
  if (platform === currentPortablePlatform()) return normalizeArch(process.arch)
  return 'x64'
}

function requirePath(filePath, description) {
  if (!existsSync(filePath)) throw new Error(`Missing ${description}: ${filePath}`)
}

function requireDirectory(dirPath, description) {
  requirePath(dirPath, description)
  if (!statSync(dirPath).isDirectory()) throw new Error(`${description} must be a directory: ${dirPath}`)
}

function launcherCmd() {
  return [
    '@echo off',
    'setlocal',
    'set "SCRIPT_DIR=%~dp0"',
    'set "COCKPIT_HOST=127.0.0.1"',
    'set "COCKPIT_PORT=8888"',
    'set "COCKPIT_URL=http://%COCKPIT_HOST%:%COCKPIT_PORT%"',
    'set "WLS_COCKPIT_TARGET="',
    'set "NODE_EXE="',
    'if exist "%SCRIPT_DIR%node\\node.exe" set "NODE_EXE=%SCRIPT_DIR%node\\node.exe"',
    'if not defined NODE_EXE if exist "%SCRIPT_DIR%node.exe" set "NODE_EXE=%SCRIPT_DIR%node.exe"',
    'if not defined NODE_EXE set "NODE_EXE=node"',
    '"%NODE_EXE%" --version >NUL 2>NUL',
    'if errorlevel 1 (',
    '  echo WLS Cockpit portable is missing a local Node runtime.',
    '  echo Place node.exe next to this launcher or provide a node\\node.exe runtime folder.',
    '  echo Press any key to close this window.',
    '  pause >NUL',
    '  endlocal & exit /b 1',
    ')',
    'echo Starting WLS Cockpit at %COCKPIT_URL%',
    'echo Close this window or use Quit in the app to stop it.',
    '"%NODE_EXE%" "%SCRIPT_DIR%dist-server\\wls-cockpit.mjs" --host=%COCKPIT_HOST% --port=%COCKPIT_PORT% --open %*',
    'set "EXIT_CODE=%ERRORLEVEL%"',
    // A clean exit (Quit in the app, or Cockpit already running) closes the window; errors stay readable.
    'if "%EXIT_CODE%"=="0" endlocal & exit /b 0',
    'echo.',
    'echo WLS Cockpit stopped with exit code %EXIT_CODE%.',
    'echo Press any key to close this window.',
    'pause >NUL',
    'endlocal & exit /b %EXIT_CODE%',
    '',
  ].join('\r\n')
}

function launcherSh() {
  return [
    '#!/usr/bin/env sh',
    'set -eu',
    'SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'if [ -x "$SCRIPT_DIR/node/bin/node" ]; then',
    '  NODE_EXE="$SCRIPT_DIR/node/bin/node"',
    'elif [ -x "$SCRIPT_DIR/node" ]; then',
    '  NODE_EXE="$SCRIPT_DIR/node"',
    'else',
    '  NODE_EXE="${NODE:-node}"',
    'fi',
    'if ! "$NODE_EXE" --version >/dev/null 2>&1; then',
    '  echo "WLS Cockpit portable cannot find Node. Install Node or place a runtime under ./node." >&2',
    '  exit 1',
    'fi',
    'exec "$NODE_EXE" "$SCRIPT_DIR/dist-server/wls-cockpit.mjs" "$@"',
    '',
  ].join('\n')
}

// Finder runs .command files in Terminal on double-click; .sh files open in an editor instead.
function launcherCommand() {
  return [
    '#!/bin/sh',
    'cd -- "$(dirname -- "$0")" || exit 1',
    'echo "Starting WLS Cockpit. Close this window or use Quit in the app to stop it."',
    './start-wls-cockpit.sh --host=127.0.0.1 --port=8888 --open "$@"',
    'status=$?',
    '[ "$status" -ne 0 ] && echo "WLS Cockpit stopped with exit code $status."',
    'exit "$status"',
    '',
  ].join('\n')
}

function portableReadme(platform, version, { windowsLauncher = false } = {}) {
  const start = platform === 'windows' ? 'start-wls-cockpit.cmd' : './start-wls-cockpit.sh'
  const defaultStartNote =
    platform === 'windows' && windowsLauncher
      ? [
          'Double-click "WLS Cockpit.exe". It starts a local server at http://127.0.0.1:8888 without a console window and opens it in the default browser; if Cockpit is already running there, it just opens the browser. It stops when you close its last browser tab or use Quit in the app header.',
          '',
          'The launcher is not code-signed: the first time, Windows SmartScreen may show "Windows protected your PC"; choose More info, then Run anyway.',
          '',
          'start-wls-cockpit.cmd starts the same server in a console window, which shows the log and any startup error.',
          '',
        ]
      : platform === 'windows'
      ? [
          'Double-click start-wls-cockpit.cmd. It starts a local server at http://127.0.0.1:8888 and opens it in the default browser; if Cockpit is already running there, it just opens the browser. Stop it with Quit in the app header or by closing the window.',
          '',
        ]
      : platform === 'macos'
        ? [
            'Double-click "WLS Cockpit.command". It starts a local server at http://127.0.0.1:8888 in a Terminal window and opens it in the default browser; if Cockpit is already running there, it just opens the browser. Stop it with Quit in the app header or by closing the window.',
            '',
            'From the signed disk image (.dmg) it opens directly. From an unsigned zip, macOS blocks it the first time: right-click "WLS Cockpit.command", choose Open, and confirm. Alternatively run: xattr -dr com.apple.quarantine <this folder>',
            '',
          ]
        : []
  const optionalExample =
    platform === 'windows'
      ? `  ${start} --target=http://wls-admin.example.com:7001`
      : `  ${start} --host=127.0.0.1 --port=8080 --target=http://wls-admin.example.com:7001`
  return [
    'WLS Cockpit Portable Runtime',
    '============================',
    '',
    `Version: ${version}`,
    '',
    'Start Cockpit:',
    '',
    `  ${start}`,
    '',
    ...defaultStartNote,
    'Optional startup defaults can still be supplied:',
    '',
    optionalExample,
    '',
    'Passwords are entered in the browser and are not accepted by the launcher.',
    'Connection profiles are saved in the local Cockpit data directory so they survive restart and --port=0 port changes.',
    'Set WLS_COCKPIT_DATA_DIR to choose that directory; the default is .wls-cockpit under the current user home.',
    '',
    'JMS/JMX local support:',
    '',
    '  WLS_COCKPIT_WLS_CLIENT_CLASSPATH=/path/to/wlthint3client.jar',
    '  WLS_COCKPIT_WL_HOME=/path/to/wlserver',
    '  WL_HOME=/path/to/wlserver',
    '  ORACLE_HOME=/path/to/oracle_home',
    '',
    'Oracle WebLogic jars are not bundled. Provide them from the local WebLogic installation.',
    '',
  ].join('\n')
}

export function assemblePortableRuntime({
  appDir = DEFAULT_APP_DIR,
  outDir = DEFAULT_OUT_DIR,
  platform = 'current',
  arch,
  nodeRuntimeDir = process.env.WLS_COCKPIT_NODE_RUNTIME_DIR,
  windowsLauncher,
} = {}) {
  const resolvedPlatform = normalizePlatform(platform)
  const resolvedArch = normalizeArch(arch ?? defaultArchForPlatform(resolvedPlatform))
  const distDir = path.join(appDir, 'dist')
  const serverDir = path.join(appDir, 'dist-server')
  const serverEntry = path.join(serverDir, 'wls-cockpit.mjs')
  const helperSource = path.join(serverDir, 'java', 'WlsJmsJmxHelper.java')

  requirePath(path.join(distDir, 'index.html'), 'production UI build')
  requirePath(serverEntry, 'self-hosted server bundle')
  requirePath(helperSource, 'JMS JMX Java helper source')

  if (resolvedPlatform === 'windows') {
    if (!nodeRuntimeDir) {
      throw new Error('Windows portable assembly requires --node-runtime-dir or WLS_COCKPIT_NODE_RUNTIME_DIR.')
    }
    requireDirectory(nodeRuntimeDir, 'Node runtime directory')
  }

  const metadata = readPackageMetadata(appDir)
  const targetDir = path.join(outDir, `wls-cockpit-${resolvedPlatform}-${resolvedArch}`)
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })

  cpSync(distDir, path.join(targetDir, 'dist'), { recursive: true })
  cpSync(serverDir, path.join(targetDir, 'dist-server'), { recursive: true })
  writeFileSync(
    path.join(targetDir, 'package.json'),
    JSON.stringify(
      {
        name: metadata.name,
        version: metadata.version,
        type: 'module',
        bin: {
          'wls-cockpit': './dist-server/wls-cockpit.mjs',
        },
        engines: metadata.engines,
      },
      null,
      2,
    ) + '\n',
  )

  if (nodeRuntimeDir) cpSync(nodeRuntimeDir, path.join(targetDir, 'node'), { recursive: true })

  const bundledWindowsLauncher = resolvedPlatform === 'windows' && Boolean(windowsLauncher)
  writeFileSync(
    path.join(targetDir, 'README.txt'),
    portableReadme(resolvedPlatform, metadata.version, { windowsLauncher: bundledWindowsLauncher }),
  )
  writeFileSync(
    path.join(targetDir, 'portable-manifest.json'),
    JSON.stringify(
      {
        name: metadata.name,
        version: metadata.version,
        platform: resolvedPlatform,
        arch: resolvedArch,
        nodeRuntimeBundled: Boolean(nodeRuntimeDir),
        entrypoint: 'dist-server/wls-cockpit.mjs',
      },
      null,
      2,
    ) + '\n',
  )

  if (resolvedPlatform === 'windows') {
    writeFileSync(path.join(targetDir, 'start-wls-cockpit.cmd'), launcherCmd())
    if (bundledWindowsLauncher) {
      requirePath(windowsLauncher, 'Windows launcher')
      cpSync(windowsLauncher, path.join(targetDir, 'WLS Cockpit.exe'))
    }
  } else {
    const launcher = path.join(targetDir, 'start-wls-cockpit.sh')
    writeFileSync(launcher, launcherSh())
    chmodSync(launcher, 0o755)
    if (resolvedPlatform === 'macos') {
      const doubleClickLauncher = path.join(targetDir, 'WLS Cockpit.command')
      writeFileSync(doubleClickLauncher, launcherCommand())
      chmodSync(doubleClickLauncher, 0o755)
    }
    chmodSync(path.join(targetDir, 'dist-server', 'wls-cockpit.mjs'), 0o755)
  }

  return targetDir
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      console.log(helpText())
    } else {
      const targetDir = assemblePortableRuntime(options)
      console.log(`Portable WLS Cockpit assembled at ${targetDir}`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Portable assembly failed.')
    process.exitCode = 1
  }
}
