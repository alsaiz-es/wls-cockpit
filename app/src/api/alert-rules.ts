// Alert thresholds for the dashboard issue queue and the local alert bell. Built-in defaults can be
// overridden in ~/.wls-cockpit/alerts.yaml (globally and per domain), which the local server reads,
// validates and serves at ALERT_RULES_PATH. A condition only alerts once it has held for the rule's
// duration, so a single busy poll (a startup burst, a GC pause) never raises an issue.

export const ALERT_RULES_PATH = '/__wls-cockpit/alert-rules'
export const ALERT_RULES_FILE_NAME = 'alerts.yaml'
export const ALERT_RULES_CONFIG_VERSION = 1

export const ALERT_RULE_IDS = [
  'threads.pending',
  'threads.hogging',
  'threads.stuck',
  'heap.percent',
  'jdbc.waiting',
  'jdbc.utilization',
  'jdbc.leaked',
  'jms.noConsumers',
  'jms.backlog',
] as const

export type AlertRuleId = (typeof ALERT_RULE_IDS)[number]
export type AlertLevel = 'warning' | 'critical'

export interface AlertRule {
  enabled: boolean
  // A level is off when its threshold is null.
  warning: number | null
  critical: number | null
  forMs: number
}

export const ALERT_RULE_INFO: Record<AlertRuleId, { label: string; unit: string; description: string }> = {
  'threads.pending': {
    label: 'Pending user requests',
    unit: 'requests',
    description: 'Requests waiting in the self-tuning thread pool queue, per server.',
  },
  'threads.hogging': {
    label: 'Hogging threads',
    unit: 'threads',
    description: 'Threads WebLogic considers hogging (running much longer than the average request), per server.',
  },
  'threads.stuck': {
    label: 'Stuck threads',
    unit: 'threads',
    description: 'Threads past the stuck thread max time (600 s by default), per server.',
  },
  'heap.percent': {
    label: 'Heap stays high',
    unit: '%',
    description:
      'Used heap that never drops below the threshold during the whole duration: garbage collection is not reclaiming memory. Peaks up to 100 % that fall after a collection are normal.',
  },
  'jdbc.waiting': {
    label: 'Waiting for a connection',
    unit: 'requests',
    description: 'Requests currently waiting for a connection, per data source.',
  },
  'jdbc.utilization': {
    label: 'Pool usage',
    unit: '%',
    description: 'Active connections as a share of the maximum capacity, per data source.',
  },
  'jdbc.leaked': {
    label: 'Leaked connections',
    unit: 'new leaks',
    description:
      'New leaked connections within the duration. The WebLogic counter only grows, so old leaks never alert.',
  },
  'jms.noConsumers': {
    label: 'Messages without consumers',
    unit: 'messages',
    description: 'Current messages on a destination that has no consumers.',
  },
  'jms.backlog': {
    label: 'Backlog',
    unit: 'messages',
    description: 'Current plus pending messages on a destination, with or without consumers.',
  },
}

export const DEFAULT_ALERT_RULES: Record<AlertRuleId, AlertRule> = {
  'threads.pending': { enabled: true, warning: 5, critical: 20, forMs: 60_000 },
  'threads.hogging': { enabled: true, warning: 5, critical: null, forMs: 120_000 },
  'threads.stuck': { enabled: true, warning: null, critical: 1, forMs: 0 },
  // Only a heap that never comes down is a signal. Critical is left to WebLogic itself, which marks
  // the server overloaded when free memory falls below OverloadProtection's low threshold.
  'heap.percent': { enabled: true, warning: 90, critical: null, forMs: 900_000 },
  'jdbc.waiting': { enabled: true, warning: 1, critical: 5, forMs: 30_000 },
  'jdbc.utilization': { enabled: true, warning: 85, critical: 95, forMs: 60_000 },
  'jdbc.leaked': { enabled: true, warning: 1, critical: null, forMs: 600_000 },
  'jms.noConsumers': { enabled: true, warning: 1, critical: null, forMs: 300_000 },
  'jms.backlog': { enabled: true, warning: 1_000, critical: 10_000, forMs: 300_000 },
}

export const ALERT_IGNORE_FAMILIES = ['servers', 'jdbc', 'jms', 'deployments'] as const
export type AlertIgnoreFamily = (typeof ALERT_IGNORE_FAMILIES)[number]

export interface AlertIgnoreRule {
  family: AlertIgnoreFamily
  // Glob on the resource name: '*' matches any run of characters. Case-sensitive, like WebLogic names.
  pattern: string
}

export interface AlertRuleOverride {
  enabled?: boolean
  warning?: number | null
  critical?: number | null
  forMs?: number
}

export interface AlertRulesScope {
  rules: Partial<Record<AlertRuleId, AlertRuleOverride>>
  ignore: AlertIgnoreRule[]
}

export interface AlertRulesConfig extends AlertRulesScope {
  version: number
  // Keyed by connection profile name.
  domains: Record<string, AlertRulesScope>
}

export interface AlertConfigError {
  path: Array<string | number>
  message: string
  line?: number
}

export type AlertRuleSource = 'default' | 'file' | 'domain'

export interface ResolvedAlertRules {
  rules: Record<AlertRuleId, AlertRule & { source: AlertRuleSource }>
  ignore: Array<AlertIgnoreRule & { source: Exclude<AlertRuleSource, 'default'> }>
}

export function emptyAlertRulesConfig(): AlertRulesConfig {
  return { version: ALERT_RULES_CONFIG_VERSION, rules: {}, ignore: [], domains: {} }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAlertRuleId(value: string): value is AlertRuleId {
  return (ALERT_RULE_IDS as readonly string[]).includes(value)
}

function isIgnoreFamily(value: string): value is AlertIgnoreFamily {
  return (ALERT_IGNORE_FAMILIES as readonly string[]).includes(value)
}

const DURATION_UNITS_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }

// '30s', '2m', '1h', '500ms', or a bare number of seconds.
export function parseAlertDuration(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value * 1_000) : null
  if (typeof value !== 'string') return null
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/.exec(value)
  if (!match) return null
  return Math.round(Number(match[1]) * DURATION_UNITS_MS[match[2] ?? 's'])
}

export function formatAlertDuration(ms: number) {
  if (ms === 0) return 'immediately'
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms % 1_000 === 0) return `${ms / 1_000}s`
  return `${ms}ms`
}

function readThreshold(value: unknown, path: Array<string | number>, errors: AlertConfigError[]) {
  if (value === null) return null
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  errors.push({ path, message: 'Threshold must be a number ≥ 0, or null to turn the level off.' })
  return undefined
}

function validateRuleOverride(raw: unknown, path: Array<string | number>, errors: AlertConfigError[]) {
  if (!isObject(raw)) {
    errors.push({ path, message: 'A rule is a map with enabled, warning, critical and for.' })
    return null
  }
  const override: AlertRuleOverride = {}
  for (const [key, value] of Object.entries(raw)) {
    const fieldPath = [...path, key]
    if (key === 'enabled') {
      if (typeof value === 'boolean') override.enabled = value
      else errors.push({ path: fieldPath, message: 'enabled must be true or false.' })
    } else if (key === 'warning' || key === 'critical') {
      const threshold = readThreshold(value, fieldPath, errors)
      if (threshold !== undefined) override[key] = threshold
    } else if (key === 'for') {
      const ms = parseAlertDuration(value)
      if (ms === null) errors.push({ path: fieldPath, message: "for must be a duration such as '30s', '2m' or '1h'." })
      else override.forMs = ms
    } else {
      errors.push({ path: fieldPath, message: `Unknown rule field '${key}'. Use enabled, warning, critical or for.` })
    }
  }
  if (
    typeof override.warning === 'number' &&
    typeof override.critical === 'number' &&
    override.warning > override.critical
  ) {
    errors.push({ path, message: 'warning must not be higher than critical.' })
    delete override.warning
    delete override.critical
  }
  return override
}

function validateScope(raw: Record<string, unknown>, path: Array<string | number>, errors: AlertConfigError[], extraKeys: string[]) {
  const scope: AlertRulesScope = { rules: {}, ignore: [] }
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'rules') {
      if (value == null) continue
      if (!isObject(value)) {
        errors.push({ path: [...path, key], message: 'rules must be a map of rule names.' })
        continue
      }
      for (const [ruleId, ruleValue] of Object.entries(value)) {
        if (!isAlertRuleId(ruleId)) {
          errors.push({ path: [...path, key, ruleId], message: `Unknown rule '${ruleId}'. Known rules: ${ALERT_RULE_IDS.join(', ')}.` })
          continue
        }
        const override = validateRuleOverride(ruleValue, [...path, key, ruleId], errors)
        if (override) scope.rules[ruleId] = override
      }
    } else if (key === 'ignore') {
      if (value == null) continue
      if (!Array.isArray(value)) {
        errors.push({ path: [...path, key], message: 'ignore must be a list such as - jms: "Module!*".' })
        continue
      }
      value.forEach((entry, index) => {
        const entryPath = [...path, key, index]
        const entries = isObject(entry) ? Object.entries(entry) : []
        const [family, pattern] = entries[0] ?? []
        if (entries.length !== 1 || typeof family !== 'string' || !isIgnoreFamily(family)) {
          errors.push({ path: entryPath, message: `Each ignore entry is one of ${ALERT_IGNORE_FAMILIES.join(', ')} with a name pattern.` })
          return
        }
        if (typeof pattern !== 'string' || pattern.trim() === '') {
          errors.push({ path: [...entryPath, family], message: 'The ignore pattern must be a non-empty string.' })
          return
        }
        scope.ignore.push({ family, pattern: pattern.trim() })
      })
    } else if (!extraKeys.includes(key)) {
      errors.push({ path: [...path, key], message: `Unknown key '${key}'.` })
    }
  }
  return scope
}

// Invalid entries are dropped and reported; everything valid still applies, and whatever is missing
// keeps its default.
export function validateAlertRulesConfig(raw: unknown): { config: AlertRulesConfig; errors: AlertConfigError[] } {
  const errors: AlertConfigError[] = []
  if (raw == null) return { config: emptyAlertRulesConfig(), errors }
  if (!isObject(raw)) {
    return { config: emptyAlertRulesConfig(), errors: [{ path: [], message: 'The file must contain a map with version, rules, ignore and domains.' }] }
  }
  if (raw.version !== undefined && raw.version !== ALERT_RULES_CONFIG_VERSION) {
    errors.push({ path: ['version'], message: `Only version ${ALERT_RULES_CONFIG_VERSION} is supported.` })
  }
  const scope = validateScope(raw, [], errors, ['version', 'domains'])
  const domains: Record<string, AlertRulesScope> = {}
  if (raw.domains != null) {
    if (!isObject(raw.domains)) {
      errors.push({ path: ['domains'], message: 'domains must be a map keyed by connection name.' })
    } else {
      for (const [name, value] of Object.entries(raw.domains)) {
        if (!isObject(value)) {
          errors.push({ path: ['domains', name], message: 'A domain entry is a map with rules and ignore.' })
          continue
        }
        domains[name] = validateScope(value, ['domains', name], errors, [])
      }
    }
  }
  return { config: { version: ALERT_RULES_CONFIG_VERSION, ...scope, domains }, errors }
}

// The server sends the validated config; turning it back into the file's shape lets the browser
// check it with the same validator instead of trusting the answer.
export function alertRulesConfigToFileShape(config: unknown): unknown {
  if (!isObject(config)) return config
  const scope = (value: unknown) => {
    if (!isObject(value)) return value
    const rules = isObject(value.rules)
      ? Object.fromEntries(
          Object.entries(value.rules).map(([id, rule]) => {
            if (!isObject(rule) || !('forMs' in rule)) return [id, rule]
            const { forMs, ...rest } = rule
            return [id, { ...rest, for: typeof forMs === 'number' ? `${forMs}ms` : forMs }]
          }),
        )
      : value.rules
    const ignore = Array.isArray(value.ignore)
      ? value.ignore.map((rule) => (isObject(rule) && typeof rule.family === 'string' ? { [rule.family]: rule.pattern } : rule))
      : value.ignore
    return { ...value, rules, ignore }
  }
  const domains = isObject(config.domains)
    ? Object.fromEntries(Object.entries(config.domains).map(([name, value]) => [name, scope(value)]))
    : config.domains
  return { ...(scope(config) as Record<string, unknown>), domains }
}

function hasFields(override: AlertRuleOverride | undefined) {
  return !!override && Object.keys(override).length > 0
}

// Drops rule entries without fields and domains without rules or ignores, which a file never
// keeps; the editor sends its state through this before saving.
export function compactAlertRulesConfig(config: AlertRulesConfig): AlertRulesConfig {
  const compactScope = (scope: AlertRulesScope): AlertRulesScope => ({
    rules: Object.fromEntries(Object.entries(scope.rules).filter(([, rule]) => hasFields(rule))),
    ignore: scope.ignore,
  })
  const domains = Object.fromEntries(
    Object.entries(config.domains)
      .map(([name, scope]) => [name, compactScope(scope)] as const)
      .filter(([, scope]) => Object.keys(scope.rules).length > 0 || scope.ignore.length > 0),
  )
  return { version: config.version, ...compactScope(config), domains }
}

export function resolveAlertRules(config: AlertRulesConfig | null | undefined, domainName?: string | null): ResolvedAlertRules {
  const domain = domainName ? config?.domains[domainName] : undefined
  const rules = Object.fromEntries(
    ALERT_RULE_IDS.map((id) => {
      const fileOverride = config?.rules[id]
      const domainOverride = domain?.rules[id]
      // An entry whose fields were all invalid overrides nothing.
      const source: AlertRuleSource = hasFields(domainOverride) ? 'domain' : hasFields(fileOverride) ? 'file' : 'default'
      return [id, { ...DEFAULT_ALERT_RULES[id], ...fileOverride, ...domainOverride, source }]
    }),
  ) as ResolvedAlertRules['rules']
  const ignore: ResolvedAlertRules['ignore'] = [
    ...(config?.ignore ?? []).map((rule) => ({ ...rule, source: 'file' as const })),
    ...(domain?.ignore ?? []).map((rule) => ({ ...rule, source: 'domain' as const })),
  ]
  return { rules, ignore }
}

export const DEFAULT_RESOLVED_ALERT_RULES = resolveAlertRules(null)

// The rules in force for the signed-in domain. Classifiers read them by default, so list pages
// and the dashboard agree on thresholds without threading the rules through every query.
let activeAlertRules: ResolvedAlertRules = DEFAULT_RESOLVED_ALERT_RULES

export function getActiveAlertRules() {
  return activeAlertRules
}

export function setActiveAlertRules(rules: ResolvedAlertRules | null) {
  activeAlertRules = rules ?? DEFAULT_RESOLVED_ALERT_RULES
}

function globPattern(pattern: string) {
  const escaped = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^${escaped.join('.*')}$`)
}

export function isAlertIgnored(
  rules: Pick<ResolvedAlertRules, 'ignore'>,
  family: AlertIgnoreFamily,
  ...names: Array<string | null | undefined>
) {
  const candidates = names.filter((name): name is string => !!name)
  return rules.ignore.some(
    (rule) => rule.family === family && candidates.some((name) => globPattern(rule.pattern).test(name)),
  )
}

// The level a single reading reaches, ignoring duration.
export function alertRuleLevel(rule: AlertRule, value: number | null | undefined): AlertLevel | null {
  if (!rule.enabled || value == null || !Number.isFinite(value)) return null
  if (rule.critical !== null && value >= rule.critical) return 'critical'
  if (rule.warning !== null && value >= rule.warning) return 'warning'
  return null
}

export function worseAlertLevel(...levels: Array<AlertLevel | null | undefined>): AlertLevel | null {
  if (levels.includes('critical')) return 'critical'
  if (levels.includes('warning')) return 'warning'
  return null
}

// A gap this long between two readings (a hidden tab stops polling) restarts the duration: the
// condition was not observed in between.
export const ALERT_SUSTAIN_MAX_GAP_MS = 60_000

interface SustainEntry {
  warningSince: number
  criticalSince: number | null
  lastSeenAt: number
}

interface LeakEntry {
  last: number
  lastSeenAt: number
  increases: Array<{ at: number; delta: number }>
}

export class AlertSustainTracker {
  private readonly levels = new Map<string, SustainEntry>()
  private readonly leaks = new Map<string, LeakEntry>()

  // The level once the reading has stayed at or above the threshold for rule.forMs.
  level(key: string, rule: AlertRule, value: number | null | undefined, now: number): AlertLevel | null {
    const instant = alertRuleLevel(rule, value)
    let entry = this.levels.get(key)
    if (entry && now - entry.lastSeenAt > ALERT_SUSTAIN_MAX_GAP_MS) entry = undefined
    if (!instant) {
      this.levels.delete(key)
      return null
    }
    const next: SustainEntry = {
      warningSince: entry?.warningSince ?? now,
      criticalSince: instant === 'critical' ? (entry?.criticalSince ?? now) : null,
      lastSeenAt: now,
    }
    this.levels.set(key, next)
    if (next.criticalSince !== null && now - next.criticalSince >= rule.forMs) return 'critical'
    if (rule.warning !== null && now - next.warningSince >= rule.forMs) return 'warning'
    return null
  }

  // For counters that only grow (leaked connections): the level reached by the increase within
  // the last rule.forMs. The first reading is the baseline, so leaks from before Cockpit started
  // watching never alert.
  increaseLevel(key: string, rule: AlertRule, value: number | null | undefined, now: number): AlertLevel | null {
    if (value == null || !Number.isFinite(value)) return null
    const entry = this.leaks.get(key)
    if (!entry || now - entry.lastSeenAt > ALERT_SUSTAIN_MAX_GAP_MS || value < entry.last) {
      this.leaks.set(key, { last: value, lastSeenAt: now, increases: [] })
      return null
    }
    const increases = entry.increases.filter((increase) => now - increase.at <= rule.forMs)
    if (value > entry.last) increases.push({ at: now, delta: value - entry.last })
    this.leaks.set(key, { last: value, lastSeenAt: now, increases })
    return alertRuleLevel({ ...rule, forMs: 0 }, increases.reduce((total, increase) => total + increase.delta, 0) || null)
  }

  // Readings for resources that disappeared (a server stopped, a pool undeployed) are dropped.
  prune(now: number) {
    for (const [key, entry] of this.levels) if (now - entry.lastSeenAt > ALERT_SUSTAIN_MAX_GAP_MS) this.levels.delete(key)
    for (const [key, entry] of this.leaks) if (now - entry.lastSeenAt > ALERT_SUSTAIN_MAX_GAP_MS) this.leaks.delete(key)
  }
}

// Without a tracker (a one-off diagnostic snapshot), each reading is judged on its own.
export function sustainedAlertLevel(
  tracker: AlertSustainTracker | null | undefined,
  key: string,
  rule: AlertRule,
  value: number | null | undefined,
  now: number,
) {
  return tracker ? tracker.level(key, rule, value, now) : alertRuleLevel(rule, value)
}

export function alertRulesExampleYaml() {
  const lines = [
    `version: ${ALERT_RULES_CONFIG_VERSION}`,
    '# Built-in defaults. Keep only the rules you change; null turns a level off.',
    'rules:',
    ...ALERT_RULE_IDS.map((id) => {
      const rule = DEFAULT_ALERT_RULES[id]
      return `  ${id}: { warning: ${rule.warning ?? 'null'}, critical: ${rule.critical ?? 'null'}, for: ${formatAlertDuration(rule.forMs) === 'immediately' ? '0s' : formatAlertDuration(rule.forMs)} }`
    }),
    '# Resources that never raise issues or alerts: servers, jdbc, jms or deployments.',
    'ignore:',
    '  - jms: "MyTestModule!*"',
    '# Per connection, by its name in Cockpit.',
    'domains:',
    '  my-lab:',
    '    rules:',
    '      heap.percent: { warning: 95 }',
  ]
  return `${lines.join('\n')}\n`
}
