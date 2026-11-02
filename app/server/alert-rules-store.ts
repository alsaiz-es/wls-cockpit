import { readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LineCounter, parseDocument } from 'yaml'
import {
  ALERT_RULES_FILE_NAME,
  emptyAlertRulesConfig,
  validateAlertRulesConfig,
  type AlertConfigError,
  type AlertRulesConfig,
} from '../src/api/alert-rules.ts'

// The optional alerts.yaml next to the connection profiles. It is read again whenever it changes
// (checked on every request, which the browser makes about once a minute), so edits apply without
// restarting Cockpit. A file with errors still applies its valid entries.
export interface AlertRulesStoreOptions {
  path?: string
  dataDir?: string
}

export interface AlertRulesFileState {
  path: string
  exists: boolean
  config: AlertRulesConfig
  errors: AlertConfigError[]
}

export function resolveAlertRulesPath(options: AlertRulesStoreOptions = {}, env: NodeJS.ProcessEnv = process.env) {
  if (options.path) return options.path
  if (env.WLS_COCKPIT_ALERT_RULES_PATH) return env.WLS_COCKPIT_ALERT_RULES_PATH
  const dataDir = options.dataDir ?? env.WLS_COCKPIT_DATA_DIR ?? path.join(os.homedir(), '.wls-cockpit')
  return path.join(dataDir, ALERT_RULES_FILE_NAME)
}

export function parseAlertRulesYaml(text: string): { config: AlertRulesConfig; errors: AlertConfigError[] } {
  const lineCounter = new LineCounter()
  const document = parseDocument(text, { lineCounter, prettyErrors: false, uniqueKeys: true })
  const lineAt = (offset: number | undefined) => (offset === undefined ? undefined : lineCounter.linePos(offset).line)
  if (document.errors.length > 0) {
    return {
      config: emptyAlertRulesConfig(),
      errors: document.errors.map((error) => ({ path: [], message: error.message.split('\n')[0], line: lineAt(error.pos[0]) })),
    }
  }
  const { config, errors } = validateAlertRulesConfig(document.toJS())
  return {
    config,
    errors: errors.map((error) => {
      const node = error.path.length > 0 ? document.getIn(error.path, true) : document.contents
      const range = node && typeof node === 'object' && 'range' in node ? (node.range as [number, number, number] | undefined) : undefined
      return { ...error, line: lineAt(range?.[0]) }
    }),
  }
}

export class AlertRulesStore {
  private cached: { mtimeMs: number; size: number; state: AlertRulesFileState } | null = null
  private readonly options: AlertRulesStoreOptions

  constructor(options: AlertRulesStoreOptions = {}) {
    this.options = options
  }

  async read(): Promise<AlertRulesFileState> {
    const filePath = resolveAlertRulesPath(this.options)
    let info
    try {
      info = await stat(filePath)
    } catch {
      this.cached = null
      return { path: filePath, exists: false, config: emptyAlertRulesConfig(), errors: [] }
    }
    if (this.cached && this.cached.mtimeMs === info.mtimeMs && this.cached.size === info.size && this.cached.state.path === filePath) {
      return this.cached.state
    }
    let state: AlertRulesFileState
    try {
      const parsed = parseAlertRulesYaml(await readFile(filePath, 'utf8'))
      state = { path: filePath, exists: true, ...parsed }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The file could not be read.'
      state = { path: filePath, exists: true, config: emptyAlertRulesConfig(), errors: [{ path: [], message }] }
    }
    this.cached = { mtimeMs: info.mtimeMs, size: info.size, state }
    return state
  }
}
