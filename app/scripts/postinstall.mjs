import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoOpenApiDir = path.resolve(appDir, '..', 'openapi')
const hasRepoOpenApi =
  existsSync(path.join(repoOpenApiDir, 'wls-14.1.2.yaml')) && existsSync(path.join(repoOpenApiDir, 'wls-12.2.1.4.yaml'))

if (process.env.WLS_COCKPIT_SKIP_GEN === '1' || !hasRepoOpenApi) {
  process.exit(0)
}

const result = spawnSync('npm', ['run', 'gen'], {
  cwd: appDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

process.exit(result.status ?? 1)
