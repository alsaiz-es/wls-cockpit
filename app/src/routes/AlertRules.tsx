import { useMemo, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import {
  ALERT_RULE_IDS,
  ALERT_RULE_INFO,
  alertRulesExampleYaml,
  formatAlertDuration,
  type AlertConfigError,
  type AlertRuleId,
  type ResolvedAlertRules,
} from '@/api/alert-rules'
import { useAlertRules } from '@/api/queries/alert-rules'
import { DataTable, KeyValueGrid, MonoText, PageHeader, type DataTableColumn } from '@/components'
import { Button } from '@/components/ui/button'

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

function sourceLabel(source: 'default' | 'file' | 'domain', domainName: string | null) {
  if (source === 'default') return <span className="text-muted-foreground">Default</span>
  if (source === 'file') return 'alerts.yaml'
  return (
    <span>
      alerts.yaml · <MonoText>{domainName}</MonoText>
    </span>
  )
}

function errorPath(error: AlertConfigError) {
  return error.path.length > 0 ? error.path.join('.') : null
}

function ExampleYaml() {
  const example = useMemo(() => alertRulesExampleYaml(), [])
  const [copied, setCopied] = useState(false)
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-medium leading-5">Example</h2>
          <p className="text-muted-foreground text-[13px] leading-[18px]">
            The built-in defaults as a file. Save it as alerts.yaml and keep only what you change.
          </p>
        </div>
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
      </div>
      <pre className="border-border bg-surface-1 overflow-x-auto border px-3 py-2 font-mono text-[12px] leading-[18px]">{example}</pre>
    </section>
  )
}

export function AlertRules() {
  const { file, resolved, domainName, query } = useAlertRules()

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
    { id: 'source', header: 'Source', cell: (row) => sourceLabel(row.source, domainName) },
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
    { id: 'source', header: 'Source', cell: (row) => sourceLabel(row.source, domainName) },
  ]

  const errors = file?.errors ?? []
  const fileStatus = !file
    ? query.error
      ? 'Could not be read; built-in defaults apply'
      : 'Loading…'
    : !file.available
      ? 'Not served by this Cockpit; built-in defaults apply'
      : !file.exists
        ? 'No file; built-in defaults apply'
        : errors.length > 0
          ? `Loaded with ${errors.length} ${errors.length === 1 ? 'error' : 'errors'}; valid entries apply`
          : 'Loaded'

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
        </section>
      ) : null}

      <section className="mt-6">
        <h2 className="mb-2 text-[14px] font-medium leading-5">Thresholds</h2>
        <p className="text-muted-foreground mb-2 text-[13px] leading-[18px]">
          A condition raises an issue only after it has held for the duration. States reported by WebLogic (failed,
          overloaded, paused, unhealthy deployments) always alert at once.
        </p>
        <DataTable columns={ruleColumns} rows={ruleRows} getRowId={(row) => row.id} loading={false} />
      </section>

      <section className="mt-6">
        <h2 className="mb-2 text-[14px] font-medium leading-5">Ignored resources</h2>
        <DataTable
          columns={ignoreColumns}
          rows={ignoreRows}
          getRowId={(row) => row.key}
          loading={false}
          empty={{ message: 'Nothing is ignored.', hint: 'List servers, jdbc, jms or deployments name patterns under ignore.' }}
        />
      </section>

      <ExampleYaml />
    </>
  )
}
