// Preloaded by `npm run test:unit`: a test that forgets to pass a data directory must not write
// to the developer's real ~/.wls-cockpit (action audit, connection profiles, alert rules).
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'wls-cockpit-test-'))
process.env.WLS_COCKPIT_DATA_DIR = dataDir
process.on('exit', () => rmSync(dataDir, { recursive: true, force: true }))
