import {
  ALERT_RULE_IDS,
  DEFAULT_ALERT_RULES,
  formatAlertDuration,
  parseAlertDuration,
  resolveAlertRules,
  type AlertIgnoreRule,
  type AlertRule,
  type AlertRuleId,
  type AlertRuleOverride,
  type AlertRulesConfig,
  type AlertRulesScope,
} from '../api/alert-rules.ts'

// The Alert Rules editor edits one scope at a time: every connection (the file's top level) or
// the signed-in connection (its entry under domains). A rule is either inherited from the scope
// above (defaults, then the file) or customised in this scope. Rules the operator does not touch
// keep their override exactly as written; a touched rule is written with all four fields.

export type AlertEditScope = 'global' | 'domain'

// Editing needs a Cockpit server that serves the file and a file that is valid YAML (the server
// refuses to rewrite one that is not). Read-only demo mode removes editing (AGENTS principle 4).
export function canEditAlertRules(
  file: { available: boolean; exists: boolean; revision: string | null; errors: Array<{ path: unknown[] }> } | undefined,
  options: { readOnlyDemoMode?: boolean } = {},
) {
  if (options.readOnlyDemoMode === true || !file?.available || !file.revision) return false
  return !(file.exists && alertRulesFileUnparseable(file))
}

// YAML syntax errors carry no path; validation errors always do.
export function alertRulesFileUnparseable(file: { exists: boolean; errors: Array<{ path: unknown[] }> }) {
  return file.exists && file.errors.some((error) => error.path.length === 0)
}

export interface RuleRowDraft {
  custom: boolean
  dirty: boolean
  enabled: boolean
  warning: string
  critical: string
  for: string
}

export type RuleRowErrors = Partial<Record<'warning' | 'critical' | 'for', string>>

export function scopeOf(config: AlertRulesConfig, scope: AlertEditScope, domainName: string | null): AlertRulesScope {
  if (scope === 'global') return config
  return (domainName ? config.domains[domainName] : undefined) ?? { rules: {}, ignore: [] }
}

// What a rule would be in this scope without an override of its own.
export function inheritedRule(config: AlertRulesConfig, scope: AlertEditScope, id: AlertRuleId): AlertRule {
  if (scope === 'global') return DEFAULT_ALERT_RULES[id]
  const resolved = resolveAlertRules(config, null).rules[id]
  return { enabled: resolved.enabled, warning: resolved.warning, critical: resolved.critical, forMs: resolved.forMs }
}

function hasFields(override: AlertRuleOverride | undefined) {
  return !!override && Object.keys(override).length > 0
}

function thresholdText(value: number | null) {
  return value === null ? '' : String(value)
}

export function durationText(ms: number) {
  return ms === 0 ? '0s' : formatAlertDuration(ms)
}

export function ruleRowFromRule(rule: AlertRule, custom: boolean): RuleRowDraft {
  return {
    custom,
    dirty: false,
    enabled: rule.enabled,
    warning: thresholdText(rule.warning),
    critical: thresholdText(rule.critical),
    for: durationText(rule.forMs),
  }
}

export function ruleRowsForScope(
  config: AlertRulesConfig,
  scope: AlertEditScope,
  domainName: string | null,
): Record<AlertRuleId, RuleRowDraft> {
  const own = scopeOf(config, scope, domainName)
  return Object.fromEntries(
    ALERT_RULE_IDS.map((id) => {
      const override = own.rules[id]
      const rule = { ...inheritedRule(config, scope, id), ...override }
      return [id, ruleRowFromRule(rule, hasFields(override))]
    }),
  ) as Record<AlertRuleId, RuleRowDraft>
}

// An empty threshold turns the level off.
function parseThreshold(text: string): { value: number | null } | { error: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { value: null }
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return { error: 'A number ≥ 0, or empty for off.' }
  return { value }
}

export function parseRuleRow(row: RuleRowDraft): { rule: AlertRule; errors: RuleRowErrors } {
  const errors: RuleRowErrors = {}
  const warning = parseThreshold(row.warning)
  const critical = parseThreshold(row.critical)
  const forMs = parseAlertDuration(row.for)
  if ('error' in warning) errors.warning = warning.error
  if ('error' in critical) errors.critical = critical.error
  if (forMs === null) errors.for = "A duration such as '30s', '2m' or '1h'."
  const rule: AlertRule = {
    enabled: row.enabled,
    warning: 'value' in warning ? warning.value : null,
    critical: 'value' in critical ? critical.value : null,
    forMs: forMs ?? 0,
  }
  if (!errors.warning && !errors.critical && rule.warning !== null && rule.critical !== null && rule.warning > rule.critical) {
    errors.critical = 'Critical must not be lower than warning.'
  }
  return { rule, errors }
}

export function ruleRowsHaveErrors(rows: Record<AlertRuleId, RuleRowDraft>) {
  return ALERT_RULE_IDS.some((id) => {
    const row = rows[id]
    return row.custom && row.dirty && Object.keys(parseRuleRow(row).errors).length > 0
  })
}

function withScope(config: AlertRulesConfig, scope: AlertEditScope, domainName: string | null, next: AlertRulesScope): AlertRulesConfig {
  if (scope === 'global') return { ...config, rules: next.rules, ignore: next.ignore }
  if (!domainName) return config
  return { ...config, domains: { ...config.domains, [domainName]: next } }
}

export function applyRuleRows(
  config: AlertRulesConfig,
  scope: AlertEditScope,
  domainName: string | null,
  rows: Record<AlertRuleId, RuleRowDraft>,
): AlertRulesConfig {
  const own = scopeOf(config, scope, domainName)
  const rules: Partial<Record<AlertRuleId, AlertRuleOverride>> = {}
  for (const id of ALERT_RULE_IDS) {
    const row = rows[id]
    if (!row.custom) continue
    if (!row.dirty) {
      if (own.rules[id]) rules[id] = own.rules[id]
      continue
    }
    const { rule } = parseRuleRow(row)
    rules[id] = { enabled: rule.enabled, warning: rule.warning, critical: rule.critical, forMs: rule.forMs }
  }
  return withScope(config, scope, domainName, { rules, ignore: own.ignore })
}

export function applyIgnoreRows(
  config: AlertRulesConfig,
  scope: AlertEditScope,
  domainName: string | null,
  ignore: AlertIgnoreRule[],
): AlertRulesConfig {
  const own = scopeOf(config, scope, domainName)
  const cleaned = ignore
    .map((rule) => ({ family: rule.family, pattern: rule.pattern.trim() }))
    .filter((rule) => rule.pattern !== '')
  return withScope(config, scope, domainName, { rules: own.rules, ignore: cleaned })
}
