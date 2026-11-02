import { Link, useLocation, useParams } from 'react-router-dom'
import { ArrowLeft, ExternalLink, Loader2, Play, RefreshCw } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { readOnlyDemoModeEnabled } from '@/api/runtime-config'
import {
  useDeploymentRuntimeDetail,
  type DeploymentHealthSymptom,
  type DeploymentRuntimeRow,
  type DeploymentSeverity,
  type DeploymentTargetRef,
} from '@/api/queries/deployments'
import { deploymentTargetLabel } from '@/api/queries/deployment-targets'
import {
  DEPLOYMENT_REQUEST_VISIBLE_SERVLET_LIMIT,
  deriveServletIntervalMetrics,
  deriveWebModuleAggregate,
  sortDeploymentRequestServlets,
  useDeploymentRequestMetrics,
  type DeploymentRequestServletMetric,
  type DeploymentRequestWebModuleMetric,
} from '@/api/queries/deployment-request-metrics'
import {
  probeDeploymentUrl,
  useDeploymentWebAccess,
  useDeploymentWebModuleAdvancedMetadata,
  type DeploymentUrlProbeResult,
  type DeploymentUrlProbeStatus,
  type DeploymentWebModule,
  type DeploymentWebModuleAdvancedMetadata,
} from '@/api/queries/deployment-web-modules'
import { Button } from '@/components/ui/button'
import { MonoText, PageHeader, RelativeTime, StatusBadge, type StatusTone } from '@/components'
import { detailReturnPath } from './detail-return-state'
import { demoSensitiveValue } from './demo-readonly-values'
import { routeParam } from './route-params'

function severityTone(severity: DeploymentSeverity): StatusTone {
  if (severity === 'critical') return 'negative'
  if (severity === 'warning') return 'warning'
  if (severity === 'healthy') return 'positive'
  return 'unknown'
}

function formatActiveVersionState(value: number | null) {
  if (value === null) return '-'
  if (value === 2) return 'ACTIVE'
  if (value === 1) return 'ACTIVE_ADMIN'
  if (value === 0) return 'INACTIVE'
  return String(value)
}

function formatDeploymentState(value: string | number | null) {
  if (value === null) return '-'
  if (value === 2) return 'ACTIVE'
  if (value === 1) return 'PREPARED'
  if (value === 0) return 'UNPREPARED'
  return String(value)
}

function targetSummary(targets: DeploymentTargetRef[]) {
  return targets.length ? targets.map(deploymentTargetLabel).join(', ') : '-'
}

function formatDeploymentOrder(value: number | null) {
  return value === null ? '-' : value.toLocaleString()
}

function formatNumber(value: number | null) {
  return value === null ? '-' : value.toLocaleString()
}

function formatRate(value: number | null) {
  if (value === null) return '-'
  return `${value.toLocaleString(undefined, { maximumFractionDigits: value >= 10 ? 1 : 2 })}/s`
}

function formatMs(value: number | null) {
  if (value === null) return '-'
  return `${value.toLocaleString(undefined, { maximumFractionDigits: value >= 10 ? 1 : 2 })} ms`
}

function formatBoolean(value: boolean | null) {
  if (value === null) return '-'
  return value ? 'TRUE' : 'FALSE'
}

function formatValue(value: string | number | boolean | null) {
  if (typeof value === 'boolean') return formatBoolean(value)
  if (typeof value === 'number') return value.toLocaleString()
  return value ?? '-'
}

function symptomTone(symptom: DeploymentHealthSymptom): StatusTone {
  const value = `${symptom.severity ?? ''} ${symptom.type ?? ''}`.toLowerCase()
  if (/\b(critical|failed|fatal|high|severe)\b/.test(value)) return 'negative'
  if (/\b(warn|warning|medium|overload)\b/.test(value)) return 'warning'
  if (/\b(ok|low|info|normal)\b/.test(value)) return 'neutral'
  return 'unknown'
}

function symptomCategoryTone(symptom: DeploymentHealthSymptom): StatusTone {
  if (symptom.category === 'jms' || symptom.category === 'resource') return 'warning'
  if (symptom.category === 'deployment') return 'neutral'
  return 'unknown'
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail?: string
}) {
  return (
    <div className="border-border bg-surface-1 min-h-[72px] border px-3 py-2">
      <div className="text-muted-foreground text-[11px] uppercase leading-[14px] tracking-[0.04em]">{label}</div>
      <MonoText className="mt-2 block truncate text-[18px] leading-6" title={value}>
        {value}
      </MonoText>
      {detail ? <div className="text-muted-foreground mt-1 truncate text-xs">{detail}</div> : null}
    </div>
  )
}

function HealthSymptomsPanel({ symptoms }: { symptoms: DeploymentHealthSymptom[] }) {
  if (symptoms.length === 0) return null

  return (
    <section className="border-border bg-surface-1 border px-3 py-3">
      <div className="mb-3">
        <h2 className="text-[14px] font-medium leading-5">Health Symptoms</h2>
        <p className="text-muted-foreground text-[13px] leading-[18px]">
          Runtime reasons reported by WebLogic health state.
        </p>
      </div>
      <div className="overflow-auto border-b border-border">
        <table className="w-full min-w-[1120px] border-collapse">
          <thead>
            <tr className="h-9 border-b border-border">
              <th className="text-muted-foreground px-3 text-left text-[13px] font-medium uppercase tracking-[0.04em]">Source</th>
              <th className="text-muted-foreground px-3 text-left text-[13px] font-medium uppercase tracking-[0.04em]">Severity</th>
              <th className="text-muted-foreground px-3 text-left text-[13px] font-medium uppercase tracking-[0.04em]">Type</th>
              <th className="text-muted-foreground px-3 text-left text-[13px] font-medium uppercase tracking-[0.04em]">Instance</th>
              <th className="text-muted-foreground px-3 text-left text-[13px] font-medium uppercase tracking-[0.04em]">Guidance</th>
              <th className="text-muted-foreground px-3 text-left text-[13px] font-medium uppercase tracking-[0.04em]">Info</th>
            </tr>
          </thead>
          <tbody>
            {symptoms.map((symptom, index) => (
              <tr key={`${symptom.source}:${symptom.instanceId ?? index}:${symptom.info ?? ''}`} className="border-t border-border align-top">
                <td className="px-3 py-2">
                  <StatusBadge kind="custom" tone={symptom.source === 'overall' ? 'warning' : 'neutral'} label={symptom.source} />
                </td>
                <td className="px-3 py-2">
                  {symptom.severity ? (
                    <StatusBadge kind="custom" tone={symptomTone(symptom)} label={symptom.severity} />
                  ) : (
                    <span className="text-muted-foreground text-[13px]">-</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <MonoText>{symptom.type ?? '-'}</MonoText>
                </td>
                <td className="max-w-[280px] px-3 py-2">
                  <MonoText className="block truncate" title={symptom.instanceId ?? undefined}>
                    {symptom.instanceId ?? '-'}
                  </MonoText>
                </td>
                <td className="max-w-[320px] px-3 py-2 text-[13px] leading-[18px]">
                  <div className="flex min-w-0 flex-col gap-1">
                    <StatusBadge kind="custom" tone={symptomCategoryTone(symptom)} label={symptom.category} className="max-w-[130px]" />
                    {symptom.summary ? <span className="font-medium">{symptom.summary}</span> : null}
                    {symptom.actionHint ? <span className="text-muted-foreground">{symptom.actionHint}</span> : null}
                    {!symptom.summary && !symptom.actionHint ? <span className="text-muted-foreground">-</span> : null}
                  </div>
                </td>
                <td className="px-3 py-2 text-[13px] leading-[18px]">
                  {symptom.info ?? '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ConfigValue({ label, value }: { label: string; value: string | number | null }) {
  const text = value === null || value === '' ? '-' : String(value)
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground text-[11px] uppercase leading-[14px] tracking-[0.04em]">{label}</div>
      <MonoText className="mt-2 block truncate text-[13px] leading-[18px]" title={text}>
        {text}
      </MonoText>
    </div>
  )
}

function PartialBanner({
  failures,
  onRetry,
}: {
  failures: Array<{ serverName: string; message: string }>
  onRetry: () => void
}) {
  if (failures.length === 0) return null
  return (
    <div className="border-status-warning/60 bg-status-warning/8 mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
      <span className="min-w-0 truncate">
        Partial data: {failures.map((failure) => `${failure.serverName}: ${failure.message}`).join(' · ')}
      </span>
      <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

function ScopeBadge({ row }: { row: DeploymentRuntimeRow }) {
  return (
    <StatusBadge
      kind="custom"
      tone={row.scope === 'external' ? 'positive' : 'neutral'}
      label={row.scope}
    />
  )
}

function probeTone(status: DeploymentUrlProbeStatus): StatusTone {
  if (status === 'success' || status === 'redirect') return 'positive'
  if (status === 'timeout' || status === 'blocked') return 'warning'
  return 'negative'
}

function probeLabel(status: DeploymentUrlProbeStatus) {
  if (status === 'success') return 'OK'
  if (status === 'redirect') return 'REDIRECT'
  if (status === 'http-error') return 'HTTP ERROR'
  if (status === 'timeout') return 'TIMEOUT'
  if (status === 'blocked') return 'BLOCKED'
  return 'NETWORK'
}

function probeSummary(result: DeploymentUrlProbeResult) {
  const status = result.statusCode ? `HTTP ${result.statusCode}` : probeLabel(result.status)
  return `${status} · ${result.latencyMs.toLocaleString()} ms`
}

function WebModuleUrl({
  module,
  result,
  pending,
  onTest,
  readOnlyDemoMode,
}: {
  module: DeploymentWebModule
  result: DeploymentUrlProbeResult | null
  pending: boolean
  onTest: (module: DeploymentWebModule) => void
  readOnlyDemoMode: boolean
}) {
  if (!module.url) {
    return <span className="text-muted-foreground text-[13px]">Unavailable</span>
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <MonoText
          as="a"
          href={module.url}
          target="_blank"
          rel="noreferrer"
          className="text-foreground min-w-0 truncate text-[13px] underline decoration-border underline-offset-2 hover:decoration-foreground"
          title={module.url}
        >
          {module.url}
        </MonoText>
        <ExternalLink className="text-muted-foreground size-3 shrink-0" strokeWidth={1.5} />
      </div>
      <div className="flex min-h-8 items-center gap-2">
        {!readOnlyDemoMode ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => onTest(module)} disabled={pending}>
            {pending ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} /> : <Play className="size-3.5" strokeWidth={1.5} />}
            {pending ? 'Testing...' : 'Test URL'}
          </Button>
        ) : null}
        {result ? (
          <div className="flex min-w-0 items-center gap-2">
            <StatusBadge kind="custom" tone={probeTone(result.status)} label={probeLabel(result.status)} />
            <MonoText className="text-muted-foreground truncate text-[12px] leading-4" title={result.message}>
              {probeSummary(result)}
            </MonoText>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function AdvancedWebModuleValue({ label, value }: { label: string; value: string | number | boolean | null }) {
  const text = formatValue(value)
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground text-[11px] uppercase leading-[14px] tracking-[0.04em]">{label}</div>
      <MonoText className="mt-1 block truncate text-[12px] leading-4" title={text}>
        {text}
      </MonoText>
    </div>
  )
}

function AdvancedWebModuleDetails({ metadata }: { metadata: DeploymentWebModuleAdvancedMetadata | null }) {
  return (
    <div className="grid gap-3 px-2 py-2 md:grid-cols-5">
      <div className="min-w-0 border-r border-border pr-3">
        <div className="text-muted-foreground mb-2 text-[11px] uppercase leading-[14px] tracking-[0.04em]">Source</div>
        <AdvancedWebModuleValue label="Source Info" value={metadata?.sourceInfo ?? null} />
        <div className="mt-2">
          <AdvancedWebModuleValue label="Log File" value={metadata?.logFilename ?? null} />
        </div>
      </div>
      <div className="min-w-0 border-r border-border pr-3">
        <div className="text-muted-foreground mb-2 text-[11px] uppercase leading-[14px] tracking-[0.04em]">Session</div>
        <AdvancedWebModuleValue label="Timeout Secs" value={metadata?.sessionTimeoutSecs ?? null} />
        <div className="mt-2 grid grid-cols-2 gap-2">
          <AdvancedWebModuleValue label="Invalidation" value={metadata?.sessionInvalidationIntervalSecs ?? null} />
          <AdvancedWebModuleValue label="Opened Total" value={metadata?.sessionsOpenedTotalCount ?? null} />
        </div>
      </div>
      <div className="min-w-0 border-r border-border pr-3">
        <div className="text-muted-foreground mb-2 text-[11px] uppercase leading-[14px] tracking-[0.04em]">Cookie</div>
        <AdvancedWebModuleValue label="Name" value={metadata?.sessionCookieName ?? null} />
        <div className="mt-2 grid grid-cols-2 gap-2">
          <AdvancedWebModuleValue label="Path" value={metadata?.sessionCookiePath ?? null} />
          <AdvancedWebModuleValue label="Max Age" value={metadata?.sessionCookieMaxAgeSecs ?? null} />
        </div>
      </div>
      <div className="min-w-0 border-r border-border pr-3">
        <div className="text-muted-foreground mb-2 text-[11px] uppercase leading-[14px] tracking-[0.04em]">Reload/JSP</div>
        <div className="grid grid-cols-2 gap-2">
          <AdvancedWebModuleValue label="Servlet Reload" value={metadata?.servletReloadCheckSecs ?? null} />
          <AdvancedWebModuleValue label="JSP Check" value={metadata?.jspPageCheckSecs ?? null} />
          <AdvancedWebModuleValue label="JSP Debug" value={metadata?.jspDebug ?? null} />
          <AdvancedWebModuleValue label="JSP Keep" value={metadata?.jspKeepGenerated ?? null} />
        </div>
      </div>
      <div className="min-w-0">
        <div className="text-muted-foreground mb-2 text-[11px] uppercase leading-[14px] tracking-[0.04em]">Flags</div>
        <div className="grid grid-cols-2 gap-2">
          <AdvancedWebModuleValue label="Monitoring" value={metadata?.sessionMonitoringEnabled ?? null} />
          <AdvancedWebModuleValue label="Session ID" value={metadata?.sessionIdLength ?? null} />
          <AdvancedWebModuleValue label="Filter Dispatch" value={metadata?.filterDispatchedRequestsEnabled ?? null} />
          <AdvancedWebModuleValue label="Index Dir" value={metadata?.indexDirectoryEnabled ?? null} />
          <AdvancedWebModuleValue label="Single Thread Pool" value={metadata?.singleThreadedServletPoolSize ?? null} />
          <AdvancedWebModuleValue label="JSP Verbose" value={metadata?.jspVerbose ?? null} />
        </div>
      </div>
    </div>
  )
}

function WebModulesSection({
  query,
  advancedQuery,
  probeResults,
  pendingProbeId,
  onProbe,
  readOnlyDemoMode,
}: {
  query: ReturnType<typeof useDeploymentWebAccess>
  advancedQuery: ReturnType<typeof useDeploymentWebModuleAdvancedMetadata>
  probeResults: Record<string, DeploymentUrlProbeResult>
  pendingProbeId: string | null
  onProbe: (module: DeploymentWebModule) => void
  readOnlyDemoMode: boolean
}) {
  const failures = [
    ...(query.data?.partialFailures ?? []),
    ...(advancedQuery.isError
      ? [
          {
            resource: 'advanced web module metadata',
            message:
              advancedQuery.error instanceof Error
                ? advancedQuery.error.message
                : 'Unable to load advanced web module metadata.',
          },
        ]
      : []),
  ]
  const webModules = query.data?.webModules ?? []
  const advancedMetadataById = new Map((advancedQuery.data ?? []).map((metadata) => [metadata.id, metadata]))
  const retryWebModules = () => void Promise.all([query.refetch(), advancedQuery.refetch()])

  return (
    <section className="border-border bg-surface-1 border px-3 py-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-medium leading-5">Web Modules</h2>
          <p className="text-muted-foreground text-[13px] leading-[18px]">
            Context roots and access checks for the selected server runtime.
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={retryWebModules} disabled={query.isFetching}>
          {query.isFetching ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} /> : <RefreshCw className="size-3.5" strokeWidth={1.5} />}
          Retry
        </Button>
      </div>

      {failures.length ? (
        <div className="border-status-warning/60 bg-status-warning/8 mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className="min-w-0 truncate">
            Partial web data: {failures.map((failure) => `${failure.resource}: ${failure.message}`).join(' · ')}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={retryWebModules}>
            Retry
          </Button>
        </div>
      ) : null}

      {query.isFetching && !query.data ? (
        <div className="text-muted-foreground flex h-20 items-center justify-center gap-2 border border-border text-[13px]">
          <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
          Loading web modules...
        </div>
      ) : null}

      {query.isError ? (
        <div className="border-status-negative/60 bg-status-negative/8 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className="min-w-0 truncate font-mono">
            {query.error instanceof Error ? query.error.message : 'Unable to load web modules.'}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}

      {!query.isFetching && !query.isError && query.data && webModules.length === 0 ? (
        <div className="border-border bg-background/30 flex min-h-20 items-center px-3 py-3 text-[13px] text-muted-foreground">
          No web context roots were reported for this deployment on the selected server.
        </div>
      ) : null}

      {webModules.length ? (
        <div className="overflow-x-auto border border-border">
          <table className="w-full min-w-[1120px] tabular-nums">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="text-muted-foreground h-9 px-2 text-[11px] font-medium uppercase tracking-[0.04em]">Module</th>
                <th className="text-muted-foreground h-9 px-2 text-[11px] font-medium uppercase tracking-[0.04em]">Context</th>
                <th className="text-muted-foreground h-9 px-2 text-[11px] font-medium uppercase tracking-[0.04em]">State</th>
                <th className="text-muted-foreground h-9 px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">Sessions</th>
                <th className="text-muted-foreground h-9 px-2 text-[11px] font-medium uppercase tracking-[0.04em]">URL Test</th>
              </tr>
            </thead>
            <tbody>
              {webModules.map((module) => (
                <Fragment key={module.id}>
                  <tr className="border-b border-border">
                    <td className="max-w-[260px] px-2 py-2 align-top">
                      <MonoText className="block truncate text-[13px]" title={module.componentName ?? module.name}>
                        {module.componentName ?? module.name}
                      </MonoText>
                      <MonoText className="text-muted-foreground mt-1 block truncate text-[12px]" title={module.moduleUri ?? module.moduleId ?? '-'}>
                        {module.moduleUri ?? module.moduleId ?? '-'}
                      </MonoText>
                    </td>
                    <td className="max-w-[220px] px-2 py-2 align-top">
                      <MonoText className="block truncate text-[13px]" title={module.contextRoot ?? '-'}>
                        {module.contextRoot ?? '-'}
                      </MonoText>
                      <MonoText className="text-muted-foreground mt-1 block truncate text-[12px]" title={module.configuredContextRoot ?? '-'}>
                        configured {module.configuredContextRoot ?? '-'}
                      </MonoText>
                    </td>
                    <td className="px-2 py-2 align-top">
                      <MonoText className="block truncate text-[13px]" title={formatDeploymentState(module.deploymentState)}>
                        {formatDeploymentState(module.deploymentState)}
                      </MonoText>
                      <MonoText className="text-muted-foreground mt-1 block truncate text-[12px]" title={module.status ?? '-'}>
                        {module.status ?? '-'}
                      </MonoText>
                    </td>
                    <td className="px-2 py-2 text-right align-top">
                      <MonoText className="block text-[13px]">{formatNumber(module.openSessionsCurrentCount)}</MonoText>
                      <MonoText className="text-muted-foreground mt-1 block text-[12px]">
                        high {formatNumber(module.openSessionsHighCount)}
                      </MonoText>
                    </td>
                    <td className="max-w-[420px] px-2 py-2 align-top">
                      <WebModuleUrl
                        module={module}
                          result={probeResults[module.id] ?? null}
                          pending={pendingProbeId === module.id}
                          onTest={onProbe}
                          readOnlyDemoMode={readOnlyDemoMode}
                        />
                    </td>
                  </tr>
                  <tr className="border-b border-border last:border-b-0">
                    <td colSpan={5} className="bg-background/20 p-0 align-top">
                      <AdvancedWebModuleDetails metadata={advancedMetadataById.get(module.id) ?? null} />
                    </td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}

function RequestMetricValue({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail?: string
}) {
  return (
    <div className="min-w-0 border border-border bg-background/30 px-2 py-2">
      <div className="text-muted-foreground text-[11px] uppercase leading-[14px] tracking-[0.04em]">{label}</div>
      <MonoText className="mt-1 block truncate text-[16px] leading-5" title={value}>
        {value}
      </MonoText>
      {detail ? <div className="text-muted-foreground mt-1 truncate text-[12px] leading-4">{detail}</div> : null}
    </div>
  )
}

function servletLabel(servlet: DeploymentRequestServletMetric) {
  return servlet.servletName ?? servlet.servletPath ?? servlet.name
}

function servletPatternSummary(servlet: DeploymentRequestServletMetric) {
  if (servlet.urlPatterns.length) return servlet.urlPatterns.join(', ')
  return servlet.url ?? servlet.servletPath ?? servlet.contextPath ?? '-'
}

function RequestMetricsServletTable({
  module,
  serverName,
  applicationName,
  scopeKey,
}: {
  module: DeploymentRequestWebModuleMetric
  serverName: string
  applicationName: string
  scopeKey: string | null | undefined
}) {
  const rows = sortDeploymentRequestServlets(
    module.servlets.map((servlet) => ({
      servlet,
      ...deriveServletIntervalMetrics({
        servlet,
        scopeKey,
        serverName,
        applicationName,
        moduleId: module.id,
      }),
    })),
  )
  const visibleRows = rows.slice(0, DEPLOYMENT_REQUEST_VISIBLE_SERVLET_LIMIT)
  const overflowCount = Math.max(0, rows.length - visibleRows.length)

  if (rows.length === 0) {
    return (
      <div className="border-border bg-background/20 mt-3 flex min-h-16 items-center px-3 py-2 text-[13px] text-muted-foreground">
        {module.servletFailure ? `Servlet metrics unavailable: ${module.servletFailure}` : 'No servlet request counters were reported for this web module.'}
      </div>
    )
  }

  return (
    <div className="mt-3 overflow-x-auto border border-border">
      <table className="w-full min-w-[980px] tabular-nums">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="text-muted-foreground h-9 px-2 text-[11px] font-medium uppercase tracking-[0.04em]">Servlet</th>
            <th className="text-muted-foreground h-9 px-2 text-[11px] font-medium uppercase tracking-[0.04em]">Pattern</th>
            <th className="text-muted-foreground h-9 px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">Invocations</th>
            <th className="text-muted-foreground h-9 px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">RPS</th>
            <th className="text-muted-foreground h-9 px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">Avg</th>
            <th className="text-muted-foreground h-9 px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">High</th>
            <th className="text-muted-foreground h-9 px-2 text-right text-[11px] font-medium uppercase tracking-[0.04em]">Low</th>
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((row) => {
            const average = row.intervalAverageExecutionTime ?? row.servlet.executionTimeAverage
            const averageDetail = row.intervalAverageExecutionTime !== null ? 'interval' : row.servlet.executionTimeAverage !== null ? 'lifetime' : null
            return (
              <tr key={row.servlet.id} className="border-b border-border last:border-b-0">
                <td className="max-w-[260px] px-2 py-2 align-top">
                  <MonoText className="block truncate text-[13px]" title={servletLabel(row.servlet)}>
                    {servletLabel(row.servlet)}
                  </MonoText>
                  <MonoText className="text-muted-foreground mt-1 block truncate text-[12px]" title={row.servlet.name}>
                    {row.servlet.name}
                  </MonoText>
                </td>
                <td className="max-w-[300px] px-2 py-2 align-top">
                  <MonoText className="block truncate text-[13px]" title={servletPatternSummary(row.servlet)}>
                    {servletPatternSummary(row.servlet)}
                  </MonoText>
                </td>
                <td className="px-2 py-2 text-right align-top">
                  <MonoText className="text-[13px]">{formatNumber(row.servlet.invocationTotalCount)}</MonoText>
                </td>
                <td className="px-2 py-2 text-right align-top">
                  <MonoText className="text-[13px]">{formatRate(row.intervalRequestRate)}</MonoText>
                  <div className="text-muted-foreground mt-1 text-[12px] leading-4">interval</div>
                </td>
                <td className="px-2 py-2 text-right align-top">
                  <MonoText className="text-[13px]">{formatMs(average)}</MonoText>
                  {averageDetail ? <div className="text-muted-foreground mt-1 text-[12px] leading-4">{averageDetail}</div> : null}
                </td>
                <td className="px-2 py-2 text-right align-top">
                  <MonoText className="text-[13px]">{formatMs(row.servlet.executionTimeHigh)}</MonoText>
                  <div className="text-muted-foreground mt-1 text-[12px] leading-4">lifetime</div>
                </td>
                <td className="px-2 py-2 text-right align-top">
                  <MonoText className="text-[13px]">{formatMs(row.servlet.executionTimeLow)}</MonoText>
                  <div className="text-muted-foreground mt-1 text-[12px] leading-4">lifetime</div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {overflowCount > 0 ? (
        <div className="border-t border-border px-2 py-2 text-[12px] text-muted-foreground">
          +{overflowCount.toLocaleString()} more servlets hidden by the top {DEPLOYMENT_REQUEST_VISIBLE_SERVLET_LIMIT.toLocaleString()} cap.
        </div>
      ) : null}
    </div>
  )
}

function RequestMetricsSection({
  query,
}: {
  query: ReturnType<typeof useDeploymentRequestMetrics>
}) {
  const data = query.data
  const webModules = data?.webModules ?? []
  const failures = [
    ...(data?.partialFailures ?? []),
    ...(query.isError
      ? [
          {
            resource: 'request metrics',
            message: query.error instanceof Error ? query.error.message : 'Unable to load request metrics.',
          },
        ]
      : []),
  ]

  return (
    <section className="border-border bg-surface-1 border px-3 py-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-medium leading-5">Request Metrics</h2>
          <p className="text-muted-foreground text-[13px] leading-[18px]">
            Servlet counters and interval rates for this deployment on the selected server.
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
          {query.isFetching ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} /> : <RefreshCw className="size-3.5" strokeWidth={1.5} />}
          Refresh
        </Button>
      </div>

      {failures.length ? (
        <div className="border-status-warning/60 bg-status-warning/8 mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className="min-w-0 truncate">
            Partial request metrics: {failures.map((failure) => `${failure.resource}: ${failure.message}`).join(' · ')}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}

      {query.isFetching && !query.data ? (
        <div className="text-muted-foreground flex h-20 items-center justify-center gap-2 border border-border text-[13px]">
          <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
          Loading request metrics...
        </div>
      ) : null}

      {query.isError && !query.data ? (
        <div className="border-status-negative/60 bg-status-negative/8 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className="min-w-0 truncate font-mono">
            {query.error instanceof Error ? query.error.message : 'Unable to load request metrics.'}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}

      {!query.isFetching && !query.isError && query.data && webModules.length === 0 ? (
        <div className="border-border bg-background/30 flex min-h-20 items-center px-3 py-3 text-[13px] text-muted-foreground">
          No web request metrics were reported for this deployment on the selected server.
        </div>
      ) : null}

      {data && webModules.length ? (
        <div className={query.isFetching ? 'space-y-3 opacity-70' : 'space-y-3'}>
          {webModules.map((module) => {
            const aggregate = deriveWebModuleAggregate({
              module,
              scopeKey: query.scopeKey,
              serverName: data.serverName,
              applicationName: data.applicationName,
            })
            const average = aggregate.intervalAverageExecutionTime ?? aggregate.lifetimeAverageExecutionTime
            const averageDetail = aggregate.intervalAverageExecutionTime !== null ? 'interval avg' : aggregate.lifetimeAverageExecutionTime !== null ? 'lifetime avg' : undefined
            return (
              <div key={module.id} className="border border-border bg-background/20 px-3 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <MonoText className="block truncate text-[14px] leading-5" title={module.componentName ?? module.name}>
                      {module.componentName ?? module.name}
                    </MonoText>
                    <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] leading-4">
                      <MonoText title={module.contextRoot ?? '-'}>{module.contextRoot ?? '-'}</MonoText>
                      <span>servlets {module.servlets.length.toLocaleString()}</span>
                      {module.status ? <span>{module.status}</span> : null}
                    </div>
                  </div>
                  <StatusBadge kind="custom" tone={module.servletFailure ? 'warning' : module.servlets.length ? 'positive' : 'unknown'} label={module.servletFailure ? 'PARTIAL' : module.servlets.length ? 'METRICS' : 'NO DATA'} />
                </div>

                <div className="mt-3 grid gap-2 md:grid-cols-6">
                  <RequestMetricValue label="Open Sessions" value={formatNumber(module.openSessionsCurrentCount)} detail={`high ${formatNumber(module.openSessionsHighCount)}`} />
                  <RequestMetricValue label="Invocations" value={formatNumber(aggregate.totalInvocations)} detail="servlet total" />
                  <RequestMetricValue label="RPS" value={formatRate(aggregate.intervalRequestRate)} detail="interval" />
                  <RequestMetricValue label="Average" value={formatMs(average)} detail={averageDetail} />
                  <RequestMetricValue label="High" value={formatMs(aggregate.executionTimeHigh)} detail="lifetime" />
                  <RequestMetricValue label="Low" value={formatMs(aggregate.executionTimeLow)} detail="lifetime" />
                </div>

                <RequestMetricsServletTable
                  module={module}
                  serverName={data.serverName}
                  applicationName={data.applicationName}
                  scopeKey={query.scopeKey}
                />
              </div>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}

export function DeploymentDetails() {
  const location = useLocation()
  const params = useParams()
  const serverName = routeParam(params.serverName)
  const deploymentName = routeParam(params.deploymentName)
  const readOnlyDemoMode = readOnlyDemoModeEnabled()
  const query = useDeploymentRuntimeDetail(serverName || null, deploymentName || null)
  const failures = query.data?.partialFailures ?? []
  const returnPath = useMemo(() => detailReturnPath(location.state, '/deployments'), [location.state])
  const row = query.data?.row ?? null
  const webServerName = row?.serverName ?? (serverName || null)
  const webApplicationName = query.data?.resolvedApplicationName ?? row?.name ?? (deploymentName || null)
  const webAccessQuery = useDeploymentWebAccess(webServerName, webApplicationName)
  const webModuleAdvancedQuery = useDeploymentWebModuleAdvancedMetadata(webServerName, webApplicationName)
  const requestMetricsQuery = useDeploymentRequestMetrics(webServerName, webApplicationName)
  const [probeResults, setProbeResults] = useState<Record<string, DeploymentUrlProbeResult>>({})
  const [pendingProbeId, setPendingProbeId] = useState<string | null>(null)

  async function refreshDetails() {
    if (webServerName && webApplicationName) {
      await Promise.all([query.refetch(), webAccessQuery.refetch(), webModuleAdvancedQuery.refetch(), requestMetricsQuery.refetch()])
    } else await query.refetch()
  }

  async function probeWebModule(module: DeploymentWebModule) {
    if (readOnlyDemoMode) return
    if (!module.url) return
    setPendingProbeId(module.id)
    const result = await probeDeploymentUrl(module.url)
    setProbeResults((current) => ({ ...current, [module.id]: result }))
    setPendingProbeId(null)
  }

  return (
    <>
      <PageHeader
        title={row?.name ?? (deploymentName || 'Deployment')}
        subtitle="Single application runtime snapshot."
        meta={
          <div className="flex w-full items-center justify-between gap-3">
            <span className="text-muted-foreground flex items-center gap-1 text-[13px] leading-[18px]">
              Updated <RelativeTime value={query.dataUpdatedAt} />
            </span>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" asChild>
                <Link to={returnPath}>
                  <ArrowLeft className="size-3.5" strokeWidth={1.5} />
                  Deployments
                </Link>
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => void refreshDetails()}>
                <RefreshCw className="size-3.5" strokeWidth={1.5} />
                Refresh
              </Button>
            </div>
          </div>
        }
      />

      <PartialBanner failures={failures} onRetry={() => void query.refetch()} />

      {query.isFetching && !query.data ? (
        <div className="text-muted-foreground flex h-24 items-center justify-center gap-2 border-b border-border text-[13px]">
          <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
          Loading...
        </div>
      ) : null}

      {query.isError ? (
        <div className="border-status-negative/60 bg-status-negative/8 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className="min-w-0 truncate font-mono">
            {query.error instanceof Error ? query.error.message : 'Unable to load application runtimes.'}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}

      {!query.isFetching && !query.isError && !row ? (
        <div className="border-border bg-surface-1 flex min-h-28 items-center justify-between gap-3 border px-3 py-3 text-[13px]">
          <div className="min-w-0">
            <div className="font-medium">Deployment not found</div>
            <MonoText className="text-muted-foreground mt-1 block truncate">
              {serverName || '-'} / {deploymentName || '-'}
            </MonoText>
          </div>
          <Button type="button" variant="outline" size="sm" asChild>
            <Link to={returnPath}>Back to deployments</Link>
          </Button>
        </div>
      ) : null}

      {row ? (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-4">
            <div className="border-border bg-surface-1 min-h-[72px] border px-3 py-2">
              <div className="text-muted-foreground text-[11px] uppercase leading-[14px] tracking-[0.04em]">Status</div>
              <div className="mt-2">
                <StatusBadge kind="custom" tone={severityTone(row.severity)} label={row.severity} />
              </div>
            </div>
            <div className="border-border bg-surface-1 min-h-[72px] border px-3 py-2">
              <div className="text-muted-foreground text-[11px] uppercase leading-[14px] tracking-[0.04em]">Scope</div>
              <div className="mt-2">
                <ScopeBadge row={row} />
              </div>
            </div>
            <Metric label="Server" value={row.serverName} />
            <Metric label="Target" value={row.targetName} />
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            <div className="border-border bg-surface-1 min-h-[72px] border px-3 py-2">
              <div className="text-muted-foreground text-[11px] uppercase leading-[14px] tracking-[0.04em]">Health</div>
              <div className="mt-2">
                <StatusBadge kind="wls-health" value={row.healthState} />
              </div>
            </div>
            <div className="border-border bg-surface-1 min-h-[72px] border px-3 py-2">
              <div className="text-muted-foreground text-[11px] uppercase leading-[14px] tracking-[0.04em]">Overall</div>
              <div className="mt-2">
                <StatusBadge kind="wls-health" value={row.overallHealthState} />
              </div>
            </div>
            <Metric label="Active" value={formatActiveVersionState(row.activeVersionState)} />
            <Metric label="Deploy" value={formatDeploymentState(row.deploymentState)} />
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <Metric label="Deployment" value={row.deploymentName} />
            <Metric label="Version" value={row.applicationVersion ?? '-'} />
            <Metric label="Lifecycle" value={row.lifecycleSupported ? 'SUPPORTED' : 'RUNTIME ONLY'} />
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <Metric label="Configured Targets" value={targetSummary(row.configuredTargets)} />
            <Metric label="Config" value={row.configurationSupported ? 'EDIT TREE' : 'RUNTIME ONLY'} />
          </div>

          <HealthSymptomsPanel symptoms={row.healthSymptoms} />

          <RequestMetricsSection query={requestMetricsQuery} />

          <section className="border-border bg-surface-1 border px-3 py-3">
            <div className="mb-3">
              <h2 className="text-[14px] font-medium leading-5">Configuration</h2>
              <p className="text-muted-foreground text-[13px] leading-[18px]">
                Read-only edit-tree metadata for the deployed artifact.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <ConfigValue label="Source Path" value={demoSensitiveValue(row.sourcePath, readOnlyDemoMode)} />
              <ConfigValue label="Plan Path" value={demoSensitiveValue(row.planPath, readOnlyDemoMode)} />
              <ConfigValue label="Module Type" value={row.moduleType} />
              <ConfigValue label="Deployment Order" value={formatDeploymentOrder(row.deploymentOrder)} />
              <ConfigValue label="Staging" value={row.stagingMode} />
              <ConfigValue label="Security DD" value={row.securityDDModel} />
            </div>
          </section>

          <WebModulesSection
            query={webAccessQuery}
            advancedQuery={webModuleAdvancedQuery}
            probeResults={probeResults}
            pendingProbeId={pendingProbeId}
            onProbe={(module) => void probeWebModule(module)}
            readOnlyDemoMode={readOnlyDemoMode}
          />
        </div>
      ) : null}
    </>
  )
}
