#!/usr/bin/env node
// Assembles WLS Cockpit.app on macOS: a native launcher (scripts/macos/launcher.c, compiled with
// the Xcode command line tools), the official Node.js binary and the built app. It is the macOS
// release artifact; scripts/sign-macos-portable.sh signs and notarizes it. The output folder is the
// content of the disk image: the app, a README and a link to Applications.
//
//   node scripts/build-macos-app.mjs --node-runtime-dir=<node-vX-darwin-arm64> --out-dir=<dir>
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const APP_BUNDLE_NAME = 'WLS Cockpit.app'
const BUNDLE_IDENTIFIER = 'io.github.alsaiz-es.wls-cockpit'
// The bundled Node.js 24 runtime needs macOS 13.5 or later.
const MINIMUM_MACOS = '13.5'

function parseArgs(args) {
  const options = { nodeRuntimeDir: process.env.WLS_COCKPIT_NODE_RUNTIME_DIR, outDir: path.join(APP_DIR, 'portable') }
  for (const arg of args) {
    if (arg.startsWith('--node-runtime-dir=')) options.nodeRuntimeDir = path.resolve(arg.slice('--node-runtime-dir='.length))
    else if (arg.startsWith('--out-dir=')) options.outDir = path.resolve(arg.slice('--out-dir='.length))
    else throw new Error(`Unknown option ${arg}`)
  }
  if (!options.nodeRuntimeDir) throw new Error('--node-runtime-dir is required (a node-vX-darwin-arm64 folder).')
  return options
}

function infoPlist(version) {
  const entries = {
    CFBundleDevelopmentRegion: 'en',
    CFBundleDisplayName: 'WLS Cockpit',
    CFBundleExecutable: 'WLS Cockpit',
    CFBundleIconFile: 'wls-cockpit',
    CFBundleIdentifier: BUNDLE_IDENTIFIER,
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: 'WLS Cockpit',
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    LSMinimumSystemVersion: MINIMUM_MACOS,
  }
  const lines = Object.entries(entries).map(([key, value]) => `  <key>${key}</key>\n  <string>${value}</string>`)
  // No Dock icon: the app has no window of its own; it serves the browser UI and stops with Quit or
  // with its last browser tab.
  lines.push('  <key>LSUIElement</key>\n  <true/>')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    ...lines,
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

export function buildMacosApp({ nodeRuntimeDir, outDir }) {
  if (process.platform !== 'darwin') throw new Error('WLS Cockpit.app is built on macOS (it compiles a native launcher).')
  const nodeBinary = path.join(nodeRuntimeDir, 'bin', 'node')
  for (const required of [nodeBinary, path.join(APP_DIR, 'dist'), path.join(APP_DIR, 'dist-server')]) {
    if (!existsSync(required)) throw new Error(`Missing ${required}; run npm run build and pass a Node runtime.`)
  }
  const { version, engines } = JSON.parse(readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'))

  const bundle = path.join(outDir, APP_BUNDLE_NAME)
  const macos = path.join(bundle, 'Contents', 'MacOS')
  const resources = path.join(bundle, 'Contents', 'Resources')
  rmSync(bundle, { recursive: true, force: true })
  mkdirSync(macos, { recursive: true })
  mkdirSync(resources, { recursive: true })

  writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), infoPlist(version))
  copyFileSync(path.join(APP_DIR, 'assets', 'icons', 'wls-cockpit.icns'), path.join(resources, 'wls-cockpit.icns'))
  cpSync(path.join(APP_DIR, 'dist'), path.join(resources, 'dist'), { recursive: true })
  cpSync(path.join(APP_DIR, 'dist-server'), path.join(resources, 'dist-server'), { recursive: true })
  writeFileSync(
    path.join(resources, 'package.json'),
    JSON.stringify({ name: 'wls-cockpit', version, type: 'module', engines }, null, 2) + '\n',
  )
  // The Node binary keeps the signature its publisher embedded in it.
  copyFileSync(nodeBinary, path.join(macos, 'node'))
  chmodSync(path.join(macos, 'node'), 0o755)
  execFileSync(
    'xcrun',
    [
      'clang',
      '-O2',
      '-Wall',
      '-Werror',
      '-arch',
      'arm64',
      `-mmacosx-version-min=${MINIMUM_MACOS}`,
      '-o',
      path.join(macos, 'WLS Cockpit'),
      path.join(APP_DIR, 'scripts', 'macos', 'launcher.c'),
    ],
    { stdio: 'inherit' },
  )
  writeFileSync(
    path.join(outDir, 'README.txt'),
    [
      `WLS Cockpit ${version}`,
      '',
      'Drag "WLS Cockpit" to Applications, or open it from here. It starts a local server at',
      'http://127.0.0.1:8888 and opens it in the default browser; if Cockpit is already running there,',
      'it just opens the browser. It has no window or Dock icon of its own: it stops when you close its',
      'last browser tab, or with Quit in the app header.',
      '',
      'Profiles and the action audit are stored under ~/.wls-cockpit/. Passwords are never saved.',
      '',
    ].join('\n'),
  )
  rmSync(path.join(outDir, 'Applications'), { force: true })
  symlinkSync('/Applications', path.join(outDir, 'Applications'))
  return bundle
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(`Built ${buildMacosApp(parseArgs(process.argv.slice(2)))}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Building WLS Cockpit.app failed.')
    process.exitCode = 1
  }
}
