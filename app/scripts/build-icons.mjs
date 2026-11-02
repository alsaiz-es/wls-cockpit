#!/usr/bin/env node
// Regenerates every icon from assets/icons/wls-cockpit.svg. The master follows the macOS icon grid
// (a 824 px tile on a 1024 px canvas); the favicon and the Windows icon use the tile without that
// margin. Needs macOS (iconutil) and rsvg-convert (brew install librsvg). The outputs are committed,
// so builds and CI do not need these tools.
//
//   node scripts/build-icons.mjs
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ICONS_DIR = path.join(APP_DIR, 'assets', 'icons')
const MASTER = path.join(ICONS_DIR, 'wls-cockpit.svg')

function render(svgPath, size, outPath) {
  execFileSync('rsvg-convert', ['--width', String(size), '--height', String(size), '--output', outPath, svgPath])
  return outPath
}

// ICO with PNG-compressed entries (Windows Vista and later).
function writeIco(pngs, outPath) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  const entries = []
  let offset = 6 + 16 * pngs.length
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0)
    entry.writeUInt8(size >= 256 ? 0 : size, 1)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += data.length
    entries.push(entry)
  }
  writeFileSync(outPath, Buffer.concat([header, ...entries, ...pngs.map((png) => png.data)]))
}

const work = mkdtempSync(path.join(os.tmpdir(), 'wls-cockpit-icons-'))
try {
  const master = readFileSync(MASTER, 'utf8')
  const tile = master.replace('viewBox="0 0 1024 1024"', 'viewBox="100 100 824 824"')
  if (tile === master) throw new Error('The master SVG must use viewBox="0 0 1024 1024".')
  const tilePath = path.join(work, 'tile.svg')
  writeFileSync(tilePath, tile)

  writeFileSync(path.join(APP_DIR, 'public', 'favicon.svg'), tile)
  render(tilePath, 180, path.join(APP_DIR, 'public', 'apple-touch-icon.png'))
  render(tilePath, 512, path.join(ICONS_DIR, 'wls-cockpit-512.png'))

  const iconset = path.join(work, 'wls-cockpit.iconset')
  execFileSync('mkdir', ['-p', iconset])
  for (const size of [16, 32, 128, 256, 512]) {
    render(MASTER, size, path.join(iconset, `icon_${size}x${size}.png`))
    render(MASTER, size * 2, path.join(iconset, `icon_${size}x${size}@2x.png`))
  }
  execFileSync('iconutil', ['--convert', 'icns', '--output', path.join(ICONS_DIR, 'wls-cockpit.icns'), iconset])

  writeIco(
    [16, 24, 32, 48, 64, 128, 256].map((size) => ({
      size,
      data: readFileSync(render(tilePath, size, path.join(work, `ico-${size}.png`))),
    })),
    path.join(ICONS_DIR, 'wls-cockpit.ico'),
  )
  console.log('Icons written to public/ and assets/icons/.')
} finally {
  rmSync(work, { recursive: true, force: true })
}
