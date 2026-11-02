#!/usr/bin/env node
// Cross-compiles WLS Cockpit.exe (scripts/windows/launcher.c with its icon and version resource)
// with mingw-w64, on Linux (apt install mingw-w64) or macOS (brew install mingw-w64).
//
//   node scripts/build-windows-launcher.mjs --out=<path/to/WLS Cockpit.exe>
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_DIR = path.join(APP_DIR, 'scripts', 'windows')
const TOOL_PREFIX = 'x86_64-w64-mingw32-'

export function buildWindowsLauncher(outPath) {
  const { version } = JSON.parse(readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'))
  const numbers = String(version).split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0)
  while (numbers.length < 3) numbers.push(0)

  const work = mkdtempSync(path.join(os.tmpdir(), 'wls-cockpit-launcher-'))
  try {
    const resource = path.join(work, 'launcher.res')
    execFileSync(
      `${TOOL_PREFIX}windres`,
      [
        `-DVERSION_NUMBER=${[...numbers, 0].join(',')}`,
        `-DVERSION_TEXT=\\"${numbers.join('.')}\\"`,
        'launcher.rc',
        '-O',
        'coff',
        '-o',
        resource,
      ],
      { cwd: SOURCE_DIR, stdio: 'inherit' },
    )
    mkdirSync(path.dirname(outPath), { recursive: true })
    execFileSync(
      `${TOOL_PREFIX}gcc`,
      ['-O2', '-Wall', '-Werror', '-municode', '-mwindows', '-static-libgcc', '-s', '-o', outPath, 'launcher.c', resource],
      { cwd: SOURCE_DIR, stdio: 'inherit' },
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  return outPath
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv.slice(2).find((arg) => arg.startsWith('--out='))
  try {
    if (!out) throw new Error('Usage: node scripts/build-windows-launcher.mjs --out=<path/to/WLS Cockpit.exe>')
    console.log(`Built ${buildWindowsLauncher(path.resolve(out.slice('--out='.length)))}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Building the Windows launcher failed.')
    process.exitCode = 1
  }
}
