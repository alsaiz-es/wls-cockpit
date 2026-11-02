import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  ALERT_IGNORE_FAMILIES,
  ALERT_RULE_IDS,
  ALERT_RULE_INFO,
  alertRulesExampleYaml,
  emptyAlertRulesConfig,
  formatAlertDuration,
  type AlertConfigError,
  type AlertIgnoreFamily,
  type AlertIgnoreRule,
  type AlertRule,
  type AlertRuleId,
  type AlertRulesConfig,
  type ResolvedAlertRules,
} from '@/api/alert-rules'
import { AlertRulesSaveError, saveAlertRules, useAlertRules, type AlertRulesFile } from '@/api/queries/alert-rules'
import { readOnlyDemoModeEnabled } from '@/api/runtime-config'
import { DataTable, KeyValueGrid, MonoText, PageHeader, type DataTableColumn } from '@/components'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  alertRulesFileUnparseable,
  applyIgnoreRows,
  applyRuleRows,
  canEditAlertRules,
  inheritedRule,
  parseRuleRow,
  ruleRowFromRule,
  ruleRowsForScope,
  ruleRowsHaveErrors,
  scopeOf,
  type AlertEditScope,
  type RuleRowDraft,
} from './alert-rules-editor-model'

type RuleRow = ResolvedAlertRules['rules'][AlertRuleId] & { id: AlertRuleId }
type IgnoreRow = ResolvedAlertRules['ignore'][number] & { key: string }

function threshold(value: number | null, unit: string, enabled: boolean) {
  if (!enabled || value === null) return <span className="text-muted-foreground">–</span>
  return (
    <span className="tabular-nums">
      ≥ {value.toLocaleString()}
      {unit === '%' ? '%' : ''}
    </span>
  )
}

function ruleSummary(rule: AlertRule, unit: string) {
  if (!rule.enabled) return 'off'
  const level = (value: number | null) => (value === null ? '–' : `≥ ${value.toLocaleString()}${unit === '%' ? '%' : ''}`)
  return `${level(rule.warning)} · ${level(rule.critical)} · ${formatAlertDuration(rule.forMs)}`
}

function sourceLabel(source: 'default' | 'file' | 'domain', domainName: string | null) {
  if (source === 'default') return <span className="text-muted-foreground">Default</span>
  if (source === 'file') return 'All connections'
  return (
    <span>
      This connection · <MonoText>{domainName}</MonoText>
    </span>
  )
}

function errorPath(error: AlertConfigError) {
  return error.path.length > 0 ? error.path.join('.') : null
}

function saveErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return 'Saving failed.'
  if (error instanceof AlertRulesSaveError && error.errors.length > 0) {
    return `${error.message} ${error.errors.map((item) => item.message).join(' ')}`
  }
  return error.message
}

function SectionHeader({ title, detail, action }: { title: string; detail?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[14px] font-medium leading-5">{title}</h2>
        {detail ? <p className="text-muted-foreground text-[13px] leading-[18px]">{detail}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  )
}

function ScopePicker({
  scope,
  domainName,
  locked,
  onChange,
}: {
  scope: AlertEditScope
  domainName: string | null
  locked: boolean
  onChange: (scope: AlertEditScope) => void
}) {
  const options: Array<{ value: AlertEditScope; label: ReactNode }> = [
    { value: 'global', label: 'All connections' },
    ...(domainName
      ? [{ value: 'domain' as const, label: <>This connection · <MonoText>{domainName}</MonoText></> }]
      : []),
  ]
  return (
    <div className="mb-2 flex items-center gap-2 text-[13px]" role="radiogroup" aria-label="Scope">
      <span className="text-muted-foreground">Applies to</span>
      <div className="border-border inline-flex border">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={scope === option.value}
            disabled={locked && scope !== option.value}
            title={locked && scope !== option.value ? 'Save or cancel the changes first.' : undefined}
            className={cn(
              'h-7 px-2.5 disabled:opacity-50',
              scope === option.value ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function SaveBar({
  path,
  saving,
  disabled,
  error,
  conflict,
  onSave,
  onCancel,
  onReload,
}: {
  path: string | null
  saving: boolean
  disabled: boolean
  error: string | null
  conflict: boolean
  onSave: () => void
  onCancel: () => void
  onReload: () => void
}) {
  return (
    <div className="mt-2 space-y-2">
      {error ? (
        <div className="border-status-negative/60 bg-status-negative/10 flex items-center justify-between gap-3 border px-3 py-2 text-[13px]" role="alert">
          <span>{error}</span>
          {conflict ? (
            <Button type="button" variant="ghost" size="sm" onClick={onReload}>
              Reload
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground min-w-0 truncate text-[12px]" title={path ?? undefined}>
          Saved to <MonoText>{path ?? 'alerts.yaml'}</MonoText>; comments and untouched entries are kept.
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={onSave} disabled={disabled || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function useSaveAlertRules(onSaved: () => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ revision, config }: { revision: string; config: AlertRulesConfig }) => saveAlertRules(revision, config),
    onSuccess: (file) => {
      queryClient.setQueryData(['alertRules'], file)
      onSaved()
    },
  })
}

function ThresholdField({
  value,
  error,
  disabled,
  label,
  placeholder,
  onChange,
}: {
  value: string
  error?: string
  disabled: boolean
  label: string
  placeholder?: string
  onChange: (value: string) => void
}) {
  return (
    <Input
      className="ml-auto h-7 w-20 px-2 text-right font-mono text-[12px]"
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={label}
      aria-invalid={error ? true : undefined}
      title={error}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

function ThresholdsEditor({
  file,
  config,
  domainName,
  onDone,
  onReload,
}: {
  file: AlertRulesFile
  config: AlertRulesConfig
  domainName: string | null
  onDone: () => void
  // Discards the edit and reads the file again (after a conflict).
  onReload: () => void
}) {
  const [scope, setScope] = useState<AlertEditScope>(domainName ? 'domain' : 'global')
  const [rows, setRows] = useState(() => ruleRowsForScope(config, domainName ? 'domain' : 'global', domainName))
  const save = useSaveAlertRules(onDone)
  const dirty = ALERT_RULE_IDS.some((id) => rows[id].dirty)
  const hasErrors = ruleRowsHaveErrors(rows)
  const own = scopeOf(config, scope, domainName)

  const update = (id: AlertRuleId, change: Partial<RuleRowDraft>) =>
    setRows((current) => ({ ...current, [id]: { ...current[id], custom: true, dirty: true, ...change } }))

  const setCustom = (id: AlertRuleId, custom: boolean) =>
    setRows((current) => ({
      ...current,
      [id]: custom
        ? { ...current[id], custom: true, dirty: true }
        : { ...ruleRowFromRule(inheritedRule(config, scope, id), false), dirty: !!own.rules[id] },
    }))

  const columns: DataTableColumn<AlertRuleId>[] = [
    {
      id: 'rule',
      header: 'Rule',
      className: 'whitespace-normal',
      cell: (id) => (
        <span className="flex min-w-0 flex-col">
          <span>{ALERT_RULE_INFO[id].label}</span>
          <MonoText className="text-muted-foreground text-[11px]">{id}</MonoText>
        </span>
      ),
    },
    {
      id: 'custom',
      header: scope === 'global' ? 'Custom' : 'Override',
      cell: (id) => (
        <input
          type="checkbox"
          className="size-3.5 accent-current"
          checked={rows[id].custom}
          aria-label={`Customise ${ALERT_RULE_INFO[id].label}`}
          onChange={(event) => setCustom(id, event.target.checked)}
        />
      ),
    },
    {
      id: 'enabled',
      header: 'On',
      cell: (id) => (
        <input
          type="checkbox"
          className="size-3.5 accent-current"
          checked={rows[id].enabled}
          disabled={!rows[id].custom}
          aria-label={`${ALERT_RULE_INFO[id].label} enabled`}
          onChange={(event) => update(id, { enabled: event.target.checked })}
        />
      ),
    },
    {
      id: 'warning',
      header: 'Warning ≥',
      align: 'right',
      cell: (id) => (
        <ThresholdField
          value={rows[id].warning}
          error={rows[id].dirty ? parseRuleRow(rows[id]).errors.warning : undefined}
          disabled={!rows[id].custom || !rows[id].enabled}
          label={`${ALERT_RULE_INFO[id].label} warning threshold`}
          placeholder="off"
          onChange={(warning) => update(id, { warning })}
        />
      ),
    },
    {
      id: 'critical',
      header: 'Critical ≥',
      align: 'right',
      cell: (id) => (
        <ThresholdField
          value={rows[id].critical}
          error={rows[id].dirty ? parseRuleRow(rows[id]).errors.critical : undefined}
          disabled={!rows[id].custom || !rows[id].enabled}
          label={`${ALERT_RULE_INFO[id].label} critical threshold`}
          placeholder="off"
          onChange={(critical) => update(id, { critical })}
        />
      ),
    },
    {
      id: 'for',
      header: 'Held for',
      align: 'right',
      cell: (id) => (
        <ThresholdField
          value={rows[id].for}
          error={rows[id].dirty ? parseRuleRow(rows[id]).errors.for : undefined}
          disabled={!rows[id].custom || !rows[id].enabled}
          label={`${ALERT_RULE_INFO[id].label} duration`}
          onChange={(value) => update(id, { for: value })}
        />
      ),
    },
    { id: 'unit', header: 'Unit', cell: (id) => <span className="text-muted-foreground">{ALERT_RULE_INFO[id].unit}</span> },
    {
      id: 'inherited',
      header: scope === 'global' ? 'Default' : 'All connections',
      cell: (id) => (
        <MonoText className="text-muted-foreground text-[12px]">
          {ruleSummary(inheritedRule(config, scope, id), ALERT_RULE_INFO[id].unit)}
        </MonoText>
      ),
    },
  ]

  return (
    <>
      <ScopePicker
        scope={scope}
        domainName={domainName}
        locked={dirty}
        onChange={(next) => {
          setScope(next)
          setRows(ruleRowsForScope(config, next, domainName))
        }}
      />
      <DataTable columns={columns} rows={[...ALERT_RULE_IDS]} getRowId={(id) => id} loading={false} />
      <p className="text-muted-foreground mt-1 text-[12px]">
        Empty threshold: that level is off. Durations such as 30s, 2m or 1h.
        {scope === 'global' ? ' Rules without Custom use the built-in default.' : ' Rules without Override use the value for all connections.'}
      </p>
      <SaveBar
        path={file.path}
        saving={save.isPending}
        disabled={!dirty || hasErrors || !file.revision}
        error={save.error ? saveErrorMessage(save.error) : null}
        conflict={save.error instanceof AlertRulesSaveError && save.error.conflict}
        onSave={() => {
          if (!file.revision) return
          save.mutate({ revision: file.revision, config: applyRuleRows(config, scope, domainName, rows) })
        }}
        onCancel={onDone}
        onReload={onReload}
      />
    </>
  )
}

function IgnoreEditor({
  file,
  config,
  domainName,
  onDone,
  onReload,
}: {
  file: AlertRulesFile
  config: AlertRulesConfig
  domainName: string | null
  onDone: () => void
  // Discards the edit and reads the file again (after a conflict).
  onReload: () => void
}) {
  const [scope, setScope] = useState<AlertEditScope>(domainName ? 'domain' : 'global')
  const [rows, setRows] = useState<AlertIgnoreRule[]>(() => scopeOf(config, domainName ? 'domain' : 'global', domainName).ignore)
  const [dirty, setDirty] = useState(false)
  const save = useSaveAlertRules(onDone)

  const change = (next: AlertIgnoreRule[]) => {
    setRows(next)
    setDirty(true)
  }

  return (
    <>
      <ScopePicker
        scope={scope}
        domainName={domainName}
        locked={dirty}
        onChange={(next) => {
          setScope(next)
          setRows(scopeOf(config, next, domainName).ignore)
        }}
      />
      <div className="border-border border">
        {rows.length === 0 ? (
          <p className="text-muted-foreground px-3 py-3 text-[13px]">Nothing is ignored in this scope.</p>
        ) : (
          rows.map((rule, index) => (
            <div key={index} className="border-border flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0">
              <select
                className="border-border bg-background h-7 border px-2 text-[13px]"
                value={rule.family}
                aria-label="Family"
                onChange={(event) =>
                  change(rows.map((item, position) => (position === index ? { ...item, family: event.target.value as AlertIgnoreFamily } : item)))
                }
              >
                {ALERT_IGNORE_FAMILIES.map((family) => (
                  <option key={family} value={family}>
                    {family}
                  </option>
                ))}
              </select>
              <Input
                className="h-7 flex-1 font-mono text-[12px]"
                value={rule.pattern}
                placeholder="Name pattern, * matches anything"
                aria-label="Name pattern"
                onChange={(event) =>
                  change(rows.map((item, position) => (position === index ? { ...item, pattern: event.target.value } : item)))
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${rule.pattern || 'pattern'}`}
                onClick={() => change(rows.filter((_, position) => position !== index))}
              >
                <Trash2 className="size-3.5" strokeWidth={1.5} />
              </Button>
            </div>
          ))
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mt-1"
        onClick={() => change([...rows, { family: 'jms', pattern: '' }])}
      >
        <Plus className="size-3.5" strokeWidth={1.5} />
        Add pattern
      </Button>
      <SaveBar
        path={file.path}
        saving={save.isPending}
        disabled={!dirty || !file.revision}
        error={save.error ? saveErrorMessage(save.error) : null}
        conflict={save.error instanceof AlertRulesSaveError && save.error.conflict}
        onSave={() => {
          if (!file.revision) return
          save.mutate({ revision: file.revision, config: applyIgnoreRows(config, scope, domainName, rows) })
        }}
        onCancel={onDone}
        onReload={onReload}
      />
    </>
  )
}

function ExampleYaml() {
  const example = useMemo(() => alertRulesExampleYaml(), [])
  const [copied, setCopied] = useState(false)
  return (
    <section className="mt-6">
      <SectionHeader
        title="Example file"
        detail="The built-in defaults as YAML, for editing alerts.yaml by hand."
        action={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              void navigator.clipboard?.writeText(example).then(() => {
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1_500)
              })
            }}
          >
            {copied ? <Check className="size-3.5" strokeWidth={1.5} /> : <Copy className="size-3.5" strokeWidth={1.5} />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        }
      />
      <details>
        <summary className="text-muted-foreground cursor-pointer text-[13px]">Show</summary>
        <pre className="border-border bg-surface-1 mt-2 overflow-x-auto border px-3 py-2 font-mono text-[12px] leading-[18px]">{example}</pre>
      </details>
    </section>
  )
}

export function AlertRules() {
  const { file, resolved, domainName, query } = useAlertRules()
  const [editing, setEditing] = useState<'rules' | 'ignore' | null>(null)
  const config = file?.config ?? emptyAlertRulesConfig()
  const errors = file?.errors ?? []
  const unparseable = !!file && alertRulesFileUnparseable(file)
  const canEdit = canEditAlertRules(file, { readOnlyDemoMode: readOnlyDemoModeEnabled() })
  const reload = () => {
    setEditing(null)
    void query.refetch()
  }

  const ruleRows = useMemo<RuleRow[]>(() => ALERT_RULE_IDS.map((id) => ({ id, ...resolved.rules[id] })), [resolved])
  const ignoreRows = useMemo<IgnoreRow[]>(
    () => resolved.ignore.map((rule, index) => ({ ...rule, key: `${rule.source}:${rule.family}:${rule.pattern}:${index}` })),
    [resolved],
  )

  const ruleColumns: DataTableColumn<RuleRow>[] = [
    {
      id: 'rule',
      header: 'Rule',
      className: 'whitespace-normal',
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className={row.enabled ? undefined : 'text-muted-foreground'}>
            {ALERT_RULE_INFO[row.id].label}
            {row.enabled ? null : ' (off)'}
          </span>
          <MonoText className="text-muted-foreground text-[11px]">{row.id}</MonoText>
        </span>
      ),
    },
    { id: 'warning', header: 'Warning', align: 'right', cell: (row) => threshold(row.warning, ALERT_RULE_INFO[row.id].unit, row.enabled) },
    { id: 'critical', header: 'Critical', align: 'right', cell: (row) => threshold(row.critical, ALERT_RULE_INFO[row.id].unit, row.enabled) },
    { id: 'for', header: 'Held for', align: 'right', cell: (row) => (row.enabled ? formatAlertDuration(row.forMs) : <span className="text-muted-foreground">–</span>) },
    { id: 'unit', header: 'Unit', cell: (row) => <span className="text-muted-foreground">{ALERT_RULE_INFO[row.id].unit}</span> },
    { id: 'source', header: 'Set in', cell: (row) => sourceLabel(row.source, domainName) },
    {
      id: 'description',
      header: 'Measures',
      className: 'whitespace-normal',
      cell: (row) => <span className="text-muted-foreground">{ALERT_RULE_INFO[row.id].description}</span>,
    },
  ]

  const ignoreColumns: DataTableColumn<IgnoreRow>[] = [
    { id: 'family', header: 'Family', cell: (row) => row.family },
    { id: 'pattern', header: 'Name pattern', cell: (row) => <MonoText>{row.pattern}</MonoText> },
    { id: 'source', header: 'Set in', cell: (row) => sourceLabel(row.source, domainName) },
  ]

  const fileStatus = !file
    ? query.error
      ? 'Could not be read; built-in defaults apply'
      : 'Loading…'
    : !file.available
      ? 'Not served by this Cockpit; built-in defaults apply'
      : !file.exists
        ? 'No file yet; built-in defaults apply'
        : errors.length > 0
          ? `Loaded with ${errors.length} ${errors.length === 1 ? 'error' : 'errors'}; valid entries apply`
          : 'Loaded'

  const editButton = (section: 'rules' | 'ignore') =>
    canEdit && editing === null ? (
      <Button type="button" variant="ghost" size="sm" data-edit-section={section} onClick={() => setEditing(section)}>
        <Pencil className="size-3.5" strokeWidth={1.5} />
        Edit
      </Button>
    ) : null

  return (
    <>
      <PageHeader
        title="Alert Rules"
        subtitle="Thresholds behind the dashboard issue queue and the alert bell."
        updatedAt={query.dataUpdatedAt || null}
        refreshing={query.isFetching}
        onRefresh={() => void query.refetch()}
      />

      <KeyValueGrid
        columns={2}
        items={[
          { label: 'File', value: file?.path ?? '–', mono: true },
          { label: 'Status', value: fileStatus },
          { label: 'Connection', value: domainName ?? '–', mono: true },
          { label: 'Reload', value: 'Automatic when the file changes (within a minute)' },
        ]}
      />

      {errors.length > 0 ? (
        <section className="border-status-warning/60 bg-status-warning/10 mt-4 border px-3 py-2" role="alert">
          <h2 className="text-[13px] font-medium leading-[18px]">alerts.yaml has problems</h2>
          <ul className="mt-1 space-y-0.5 text-[13px] leading-[18px]">
            {errors.map((error, index) => (
              <li key={`${index}:${error.message}`}>
                {error.line ? <MonoText className="text-muted-foreground">line {error.line} · </MonoText> : null}
                {errorPath(error) ? <MonoText>{errorPath(error)}</MonoText> : null}
                {errorPath(error) ? ': ' : null}
                {error.message}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground mt-1 text-[12px]">
            {unparseable
              ? 'Editing is off until the file is valid YAML again: fix or delete it by hand.'
              : 'Saving from this page drops the invalid entries listed above.'}
          </p>
        </section>
      ) : null}

      <section className="mt-6">
        <SectionHeader
          title="Thresholds"
          detail="A condition raises an issue only after it has held for the duration. States reported by WebLogic (failed, overloaded, paused, unhealthy deployments) always alert at once."
          action={editButton('rules')}
        />
        {editing === 'rules' && file ? (
          <ThresholdsEditor file={file} config={config} domainName={domainName} onDone={() => setEditing(null)} onReload={reload} />
        ) : (
          <DataTable columns={ruleColumns} rows={ruleRows} getRowId={(row) => row.id} loading={false} />
        )}
      </section>

      <section className="mt-6">
        <SectionHeader
          title="Ignored resources"
          detail="Resources matching these names raise neither issues nor alerts."
          action={editButton('ignore')}
        />
        {editing === 'ignore' && file ? (
          <IgnoreEditor file={file} config={config} domainName={domainName} onDone={() => setEditing(null)} onReload={reload} />
        ) : (
          <DataTable
            columns={ignoreColumns}
            rows={ignoreRows}
            getRowId={(row) => row.key}
            loading={false}
            empty={{ message: 'Nothing is ignored.', hint: canEdit ? 'Use Edit to add name patterns.' : undefined }}
          />
        )}
      </section>

      <ExampleYaml />
    </>
  )
}
