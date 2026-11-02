import { chmodSync, cpSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const binPath = path.join(appDir, 'dist-server', 'wls-cockpit.mjs')
const helperSourceDir = path.join(appDir, 'server', 'java')
const helperDistDir = path.join(appDir, 'dist-server', 'java')
// The license lives at the repository root; npm only packs a LICENSE found in the package root.
const repoLicensePath = path.join(appDir, '..', 'LICENSE')
const packageLicensePath = path.join(appDir, 'LICENSE')

if (existsSync(binPath)) chmodSync(binPath, 0o755)
if (existsSync(helperSourceDir)) cpSync(helperSourceDir, helperDistDir, { recursive: true })
if (existsSync(repoLicensePath)) cpSync(repoLicensePath, packageLicensePath)
