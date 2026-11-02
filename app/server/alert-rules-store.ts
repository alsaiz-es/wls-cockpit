import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Document, LineCounter, isMap, isScalar, parseDocument } from 'yaml'
import {
  ALERT_RULE_IDS,
  ALERT_RULES_FILE_NAME,
  compactAlertRulesConfig,
  emptyAlertRulesConfig,
  formatAlertDuration,
  validateAlertRulesConfig,
  type AlertConfigError,
  type AlertRuleOverride,
  type AlertRulesConfig,
  type AlertRulesScope,
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
  // Changes whenever the file does; a save names the revision it was based on.
  revision: string
  config: AlertRulesConfig
  errors: AlertConfigError[]
}

export type AlertRulesWriteResult =
  | { ok: true; state: AlertRulesFileState }
  | { ok: false; reason: 'conflict' | 'unparseable'; message: string; state: AlertRulesFileState }

function revisionOf(info: { mtimeMs: number; size: number } | null) {
  return info ? `${Math.trunc(info.mtimeMs)}-${info.size}` : 'none'
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
      return { path: filePath, exists: false, revision: revisionOf(null), config: emptyAlertRulesConfig(), errors: [] }
    }
    if (this.cached && this.cached.mtimeMs === info.mtimeMs && this.cached.size === info.size && this.cached.state.path === filePath) {
      return this.cached.state
    }
    let state: AlertRulesFileState
    try {
      const parsed = parseAlertRulesYaml(await readFile(filePath, 'utf8'))
      state = { path: filePath, exists: true, revision: revisionOf(info), ...parsed }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The file could not be read.'
      state = { path: filePath, exists: true, revision: revisionOf(info), config: emptyAlertRulesConfig(), errors: [{ path: [], message }] }
    }
    this.cached = { mtimeMs: info.mtimeMs, size: info.size, state }
    return state
  }

  // Saves a config from the Alert Rules editor. Refused when the file changed since the editor
  // loaded it (baseRevision), or when it is not valid YAML (fixing that by hand is safer than
  // overwriting it).
  async write(baseRevision: string, edited: AlertRulesConfig): Promise<AlertRulesWriteResult> {
    const config = compactAlertRulesConfig(edited)
    const current = await this.read()
    if (current.revision !== baseRevision) {
      return { ok: false, reason: 'conflict', message: 'alerts.yaml changed since the editor loaded it. Reload and try again.', state: current }
    }
    const existing = current.exists ? await readFile(current.path, 'utf8') : null
    if (existing !== null && parseDocument(existing).errors.length > 0) {
      return { ok: false, reason: 'unparseable', message: 'alerts.yaml is not valid YAML. Fix or delete it by hand first.', state: current }
    }
    const text = renderAlertRulesYaml(existing, config)
    const check = parseAlertRulesYaml(text)
    if (check.errors.length > 0 || canonicalJson(check.config) !== canonicalJson(config)) {
      throw new Error('The edited alert rules did not survive a round trip through YAML; nothing was written.')
    }
    await mkdir(path.dirname(current.path), { recursive: true })
    const temporary = `${current.path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await writeFile(temporary, text, 'utf8')
      await rename(temporary, current.path)
    } finally {
      await rm(temporary, { force: true })
    }
    this.cached = null
    return { ok: true, state: await this.read() }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function fileFields(override: AlertRuleOverride | undefined) {
  const fields: Partial<Record<'enabled' | 'warning' | 'critical' | 'for', unknown>> = {}
  if (!override) return fields
  if (override.enabled !== undefined) fields.enabled = override.enabled
  if (override.warning !== undefined) fields.warning = override.warning
  if (override.critical !== undefined) fields.critical = override.critical
  if (override.forMs !== undefined) fields.for = override.forMs === 0 ? '0s' : formatAlertDuration(override.forMs)
  return fields
}

function mapKeys(node: unknown): string[] {
  return isMap(node) ? node.items.map((pair) => String(isScalar(pair.key) ? pair.key.value : pair.key)) : []
}

function syncScope(document: Document, base: string[], scope: AlertRulesScope) {
  const rulesPath = [...base, 'rules']
  for (const key of mapKeys(document.getIn(rulesPath, true))) {
    if (!(ALERT_RULE_IDS as readonly string[]).includes(key)) document.deleteIn([...rulesPath, key])
  }
  for (const id of ALERT_RULE_IDS) {
    const rulePath = [...rulesPath, id]
    const fields = fileFields(scope.rules[id])
    if (Object.keys(fields).length === 0) {
      if (document.hasIn(rulePath)) document.deleteIn(rulePath)
      continue
    }
    const node = document.getIn(rulePath, true)
    if (!isMap(node)) {
      document.setIn(rulePath, document.createNode(fields, { flow: true }))
      continue
    }
    // Edit the existing map in place so its comments and layout survive.
    for (const key of mapKeys(node)) if (!(key in fields)) node.delete(key)
    for (const [key, value] of Object.entries(fields)) node.set(key, value)
  }
  if (document.hasIn(rulesPath) && mapKeys(document.getIn(rulesPath, true)).length === 0) document.deleteIn(rulesPath)

  const ignorePath = [...base, 'ignore']
  const ignore = scope.ignore.map((rule) => ({ [rule.family]: rule.pattern }))
  const currentIgnore = document.hasIn(ignorePath) ? JSON.stringify((document.getIn(ignorePath, true) as { toJSON?: () => unknown })?.toJSON?.()) : null
  if (ignore.length === 0) {
    if (document.hasIn(ignorePath)) document.deleteIn(ignorePath)
  } else if (currentIgnore !== JSON.stringify(ignore)) {
    document.setIn(ignorePath, document.createNode(ignore))
  }
}

function scopeIsEmpty(scope: AlertRulesScope | undefined) {
  return !scope || (scope.ignore.length === 0 && Object.values(scope.rules).every((rule) => Object.keys(fileFields(rule)).length === 0))
}

// Applies config to the existing file text, touching only what changed.
export function renderAlertRulesYaml(existing: string | null, config: AlertRulesConfig): string {
  const document = existing !== null && existing.trim() !== '' ? parseDocument(existing) : new Document({ version: config.version })
  if (existing === null || existing.trim() === '') {
    document.commentBefore = ' WLS Cockpit alert thresholds, edited from the Alert Rules page. See the README.'
  }
  if (!document.hasIn(['version'])) document.setIn(['version'], config.version)
  syncScope(document, [], config)
  for (const name of mapKeys(document.getIn(['domains'], true))) {
    if (scopeIsEmpty(config.domains[name])) document.deleteIn(['domains', name])
  }
  for (const [name, scope] of Object.entries(config.domains)) {
    if (!scopeIsEmpty(scope)) syncScope(document, ['domains', name], scope)
  }
  if (document.hasIn(['domains']) && mapKeys(document.getIn(['domains'], true)).length === 0) document.deleteIn(['domains'])
  return document.toString()
}
