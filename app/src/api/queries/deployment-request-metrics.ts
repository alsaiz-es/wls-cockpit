import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  createClient12,
  createClient14,
  wlsCredentialCacheKey,
  type WlsCredentials,
} from '../client.ts'
import { useAuth } from '../../auth/useAuth.ts'
import {
  createWlsHttpError,
  withWlsRestTimeout,
} from '../wls-errors.ts'
import {
  getMetricHistorySeries,
  metricResourceId,
  type MetricHistorySeries,
  type MetricHistorySampleInput,
  useMetricHistoryRecorder,
} from './metric-history.ts'
import { useRefreshStaleQueryOnVisibleReturn, useVisiblePollingInterval } from '../query-polling.ts'
import { normalizeContextRoot } from './deployment-web-modules.ts'

export const DEPLOYMENT_REQUEST_METRICS_TIMEOUT_MS = 5_000
export const DEPLOYMENT_REQUEST_METRICS_SERVLET_CONCURRENCY = 4
export const DEPLOYMENT_REQUEST_METRIC_FAMILY = 'deployment-request'
export const DEPLOYMENT_REQUEST_INVOCATIONS_METRIC = 'invocations.total'
export const DEPLOYMENT_REQUEST_EXECUTION_TOTAL_METRIC = 'execution.ms.total'
export const DEPLOYMENT_REQUEST_VISIBLE_SERVLET_LIMIT = 20

export const DEPLOYMENT_REQUEST_WEB_MODULE_FIELDS =
  'name,type,componentName,moduleId,moduleURI,contextRoot,configuredContextRoot,deploymentState,status,openSessionsCurrentCount,openSessionsHighCount'
export const DEPLOYMENT_REQUEST_SERVLET_FIELDS =
  'name,type,contextPath,servletName,servletPath,URL,URLPatterns,invocationTotalCount,executionTimeAverage,executionTimeHigh,executionTimeLow,executionTimeTotal'

export interface DeploymentRequestMetricFailure {
  resource: string
  message: string
}

export interface DeploymentRequestServletMetric {
  id: string
  name: string
  servletName: string | null
  servletPath: string | null
  contextPath: string | null
  url: string | null
  urlPatterns: string[]
  invocationTotalCount: number | null
  executionTimeAverage: number | null
  executionTimeHigh: number | null
  executionTimeLow: number | null
  executionTimeTotal: number | null
}

export interface DeploymentRequestWebModuleMetric {
  id: string
  name: string
  componentName: string | null
  moduleId: string | null
  moduleUri: string | null
  contextRoot: string | null
  configuredContextRoot: string | null
  deploymentState: string | number | null
  status: string | null
  openSessionsCurrentCount: number | null
  openSessionsHighCount: number | null
  servlets: DeploymentRequestServletMetric[]
  servletFailure: string | null
}

export interface DeploymentRequestMetricsSnapshot {
  serverName: string
  applicationName: string
  webModules: DeploymentRequestWebModuleMetric[]
  partialFailures: DeploymentRequestMetricFailure[]
}

export interface DeploymentRequestRate {
  value: number | null
  delta: number | null
  elapsedMs: number | null
}

export interface DeploymentRequestModuleAggregate {
  totalInvocations: number | null
  intervalRequestRate: number | null
  intervalAverageExecutionTime: number | null
  lifetimeAverageExecutionTime: number | null
  executionTimeHigh: number | null
  executionTimeLow: number | null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readItems(data: unknown): unknown[] {
  return isObject(data) && Array.isArray(data.items) ? data.items : []
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const text = readString(item)
    return text ? [text] : []
  })
}

function valueOrFallback(...values: Array<string | null | undefined>) {
  return values.find((value) => value && value.trim().length > 0) ?? null
}

function clientFor(creds: WlsCredentials) {
  return creds.version === '14.1.2.0.0' ? createClient14(creds) : createClient12(creds)
}

export function deploymentRequestWebModuleResourceId(
  serverName: string,
  applicationName: string,
  moduleId: string,
) {
  return metricResourceId('deployment', serverName, applicationName, 'web-module', moduleId)
}

export function deploymentRequestServletResourceId(
  serverName: string,
  applicationName: string,
  moduleId: string,
  servletId: string,
) {
  return metricResourceId('deployment', serverName, applicationName, 'web-module', moduleId, 'servlet', servletId)
}

export function normalizeDeploymentRequestWebModule(item: unknown): DeploymentRequestWebModuleMetric | null {
  if (!isObject(item) || item.type !== 'WebAppComponentRuntime') return null

  const name = readString(item.name) ?? readString(item.componentName) ?? readString(item.moduleId)
  if (!name) return null

  return {
    id: name,
    name,
    componentName: readString(item.componentName),
    moduleId: readString(item.moduleId),
    moduleUri: readString(item.moduleURI),
    contextRoot: normalizeContextRoot(item.contextRoot),
    configuredContextRoot: normalizeContextRoot(item.configuredContextRoot),
    deploymentState: readString(item.deploymentState) ?? readNumber(item.deploymentState),
    status: readString(item.status),
    openSessionsCurrentCount: readNumber(item.openSessionsCurrentCount),
    openSessionsHighCount: readNumber(item.openSessionsHighCount),
    servlets: [],
    servletFailure: null,
  }
}

export function normalizeDeploymentRequestServlet(item: unknown): DeploymentRequestServletMetric | null {
  if (!isObject(item)) return null

  const name = valueOrFallback(readString(item.name), readString(item.servletName), readString(item.servletPath), readString(item.URL))
  if (!name) return null

  return {
    id: name,
    name,
    servletName: readString(item.servletName),
    servletPath: readString(item.servletPath),
    contextPath: readString(item.contextPath),
    url: readString(item.URL),
    urlPatterns: readStringArray(item.URLPatterns),
    invocationTotalCount: readNumber(item.invocationTotalCount),
    executionTimeAverage: readNumber(item.executionTimeAverage),
    executionTimeHigh: readNumber(item.executionTimeHigh),
    executionTimeLow: readNumber(item.executionTimeLow),
    executionTimeTotal: readNumber(item.executionTimeTotal),
  }
}

export function deploymentRequestMetricsQueryKey(
  creds: WlsCredentials | null | undefined,
  serverName: string | null | undefined,
  applicationName: string | null | undefined,
) {
  return ['deployment-request-metrics', wlsCredentialCacheKey(creds), serverName ?? '', applicationName ?? ''] as const
}

export function deploymentRequestMetricsEnabled(
  creds: WlsCredentials | null | undefined,
  serverName: string | null | undefined,
  applicationName: string | null | undefined,
) {
  return !!creds && !!serverName && !!applicationName
}

function failureMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Deployment request metrics failed.'
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapItem: (item: T) => Promise<R>,
) {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, concurrency), items.length)

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await mapItem(items[index] as T)
      }
    }),
  )

  return results
}

async function fetchWebModules(creds: WlsCredentials, serverName: string, applicationName: string) {
  const res = await withWlsRestTimeout(
    `Deployment request metric web modules ${serverName}/${applicationName}`,
    (signal) =>
      clientFor(creds).GET(
        '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/applicationRuntimes/{applicationName}/componentRuntimes',
        {
          signal,
          params: {
            path: { version: creds.version, serverName, applicationName },
            query: {
              fields: DEPLOYMENT_REQUEST_WEB_MODULE_FIELDS,
              links: 'none',
            },
          },
        },
      ),
    DEPLOYMENT_REQUEST_METRICS_TIMEOUT_MS,
  )

  if (res.error) throw createWlsHttpError(`Deployment request metric web modules ${serverName}/${applicationName}`, res.response, res.error)

  return readItems(res.data).flatMap((item) => {
    const module = normalizeDeploymentRequestWebModule(item)
    return module ? [module] : []
  })
}

async function fetchServletsForModule(
  creds: WlsCredentials,
  serverName: string,
  applicationName: string,
  module: DeploymentRequestWebModuleMetric,
) {
  const operation = `Deployment request metric servlets ${serverName}/${applicationName}/${module.name}`
  const res = await withWlsRestTimeout(
    operation,
    (signal) =>
      clientFor(creds).GET(
        '/management/weblogic/{version}/domainRuntime/serverRuntimes/{serverName}/applicationRuntimes/{applicationName}/componentRuntimes/{componentName}/servlets',
        {
          signal,
          params: {
            path: { version: creds.version, serverName, applicationName, componentName: module.name },
            query: {
              fields: DEPLOYMENT_REQUEST_SERVLET_FIELDS,
              links: 'none',
            },
          },
        },
      ),
    DEPLOYMENT_REQUEST_METRICS_TIMEOUT_MS,
  )

  if (res.error) throw createWlsHttpError(operation, res.response, res.error)

  return readItems(res.data).flatMap((item) => {
    const servlet = normalizeDeploymentRequestServlet(item)
    return servlet ? [servlet] : []
  })
}

export async function fetchDeploymentRequestMetricsSnapshot(
  creds: WlsCredentials,
  serverName: string,
  applicationName: string,
): Promise<DeploymentRequestMetricsSnapshot> {
  let modules: DeploymentRequestWebModuleMetric[]

  try {
    modules = await fetchWebModules(creds, serverName, applicationName)
  } catch (error) {
    return {
      serverName,
      applicationName,
      webModules: [],
      partialFailures: [
        {
          resource: `request metric web modules ${serverName}/${applicationName}`,
          message: failureMessage(error),
        },
      ],
    }
  }

  const partialFailures: DeploymentRequestMetricFailure[] = []
  const webModules = await mapWithConcurrency(
    modules,
    DEPLOYMENT_REQUEST_METRICS_SERVLET_CONCURRENCY,
    async (module) => {
      try {
        const servlets = await fetchServletsForModule(creds, serverName, applicationName, module)
        return { ...module, servlets, servletFailure: null }
      } catch (error) {
        const message = failureMessage(error)
        partialFailures.push({
          resource: `servlets ${serverName}/${applicationName}/${module.name}`,
          message,
        })
        return { ...module, servlets: [], servletFailure: message }
      }
    },
  )

  return {
    serverName,
    applicationName,
    webModules,
    partialFailures,
  }
}

export function projectDeploymentRequestMetricSamples(snapshot: DeploymentRequestMetricsSnapshot | null | undefined) {
  if (!snapshot) return []

  const samples: MetricHistorySampleInput[] = []
  for (const module of snapshot.webModules) {
    for (const servlet of module.servlets) {
      const resourceId = deploymentRequestServletResourceId(snapshot.serverName, snapshot.applicationName, module.id, servlet.id)
      samples.push({
        family: DEPLOYMENT_REQUEST_METRIC_FAMILY,
        resourceId,
        metric: DEPLOYMENT_REQUEST_INVOCATIONS_METRIC,
        value: servlet.invocationTotalCount,
      })
      samples.push({
        family: DEPLOYMENT_REQUEST_METRIC_FAMILY,
        resourceId,
        metric: DEPLOYMENT_REQUEST_EXECUTION_TOTAL_METRIC,
        value: servlet.executionTimeTotal,
      })
    }
  }

  return samples
}

function lastTwoSamples(series: MetricHistorySeries) {
  if (series.samples.length < 2) return null
  const current = series.samples.at(-1)
  const previous = series.samples.at(-2)
  if (!current || !previous || current.gapBefore) return null
  const elapsedMs = current.timestamp - previous.timestamp
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null
  const delta = current.value - previous.value
  if (!Number.isFinite(delta) || delta < 0) return null
  return { delta, elapsedMs }
}

export function deriveRequestRate(series: MetricHistorySeries): DeploymentRequestRate {
  const interval = lastTwoSamples(series)
  if (!interval) return { value: null, delta: null, elapsedMs: null }
  return {
    value: interval.delta / (interval.elapsedMs / 1000),
    delta: interval.delta,
    elapsedMs: interval.elapsedMs,
  }
}

export function deriveIntervalAverageExecutionTime(
  executionTotalSeries: MetricHistorySeries,
  invocationSeries: MetricHistorySeries,
) {
  const execution = lastTwoSamples(executionTotalSeries)
  const invocations = lastTwoSamples(invocationSeries)
  if (!execution || !invocations || invocations.delta <= 0) return null
  return execution.delta / invocations.delta
}

function sum(values: Array<number | null>) {
  const valid = values.filter((value): value is number => value !== null)
  return valid.length ? valid.reduce((total, value) => total + value, 0) : null
}

function max(values: Array<number | null>) {
  const valid = values.filter((value): value is number => value !== null)
  return valid.length ? Math.max(...valid) : null
}

function min(values: Array<number | null>) {
  const valid = values.filter((value): value is number => value !== null)
  return valid.length ? Math.min(...valid) : null
}

export function deriveWeightedLifetimeAverageExecutionTime(servlets: DeploymentRequestServletMetric[]) {
  const totalExecution = sum(servlets.map((servlet) => servlet.executionTimeTotal))
  const totalInvocations = sum(servlets.map((servlet) => servlet.invocationTotalCount))
  if (totalExecution !== null && totalInvocations !== null && totalInvocations > 0) return totalExecution / totalInvocations

  let weightedTotal = 0
  let weightedCount = 0
  for (const servlet of servlets) {
    if (servlet.executionTimeAverage === null || servlet.invocationTotalCount === null || servlet.invocationTotalCount <= 0) continue
    weightedTotal += servlet.executionTimeAverage * servlet.invocationTotalCount
    weightedCount += servlet.invocationTotalCount
  }
  return weightedCount > 0 ? weightedTotal / weightedCount : null
}

export function deriveWebModuleAggregate({
  module,
  scopeKey,
  serverName,
  applicationName,
}: {
  module: DeploymentRequestWebModuleMetric
  scopeKey: string | null | undefined
  serverName: string
  applicationName: string
}): DeploymentRequestModuleAggregate {
  let intervalRate: number | null = null
  let intervalExecutionDelta = 0
  let intervalInvocationDelta = 0

  for (const servlet of module.servlets) {
    const resourceId = deploymentRequestServletResourceId(serverName, applicationName, module.id, servlet.id)
    const invocationSeries = getMetricHistorySeries(
      scopeKey,
      DEPLOYMENT_REQUEST_METRIC_FAMILY,
      resourceId,
      DEPLOYMENT_REQUEST_INVOCATIONS_METRIC,
    )
    const executionSeries = getMetricHistorySeries(
      scopeKey,
      DEPLOYMENT_REQUEST_METRIC_FAMILY,
      resourceId,
      DEPLOYMENT_REQUEST_EXECUTION_TOTAL_METRIC,
    )
    const rate = deriveRequestRate(invocationSeries)
    if (rate.value !== null) intervalRate = (intervalRate ?? 0) + rate.value

    const invocations = lastTwoSamples(invocationSeries)
    const execution = lastTwoSamples(executionSeries)
    if (invocations && execution && invocations.delta > 0) {
      intervalInvocationDelta += invocations.delta
      intervalExecutionDelta += execution.delta
    }
  }

  return {
    totalInvocations: sum(module.servlets.map((servlet) => servlet.invocationTotalCount)),
    intervalRequestRate: intervalRate,
    intervalAverageExecutionTime:
      intervalInvocationDelta > 0 ? intervalExecutionDelta / intervalInvocationDelta : null,
    lifetimeAverageExecutionTime: deriveWeightedLifetimeAverageExecutionTime(module.servlets),
    executionTimeHigh: max(module.servlets.map((servlet) => servlet.executionTimeHigh)),
    executionTimeLow: min(module.servlets.map((servlet) => servlet.executionTimeLow)),
  }
}

export function deriveServletIntervalMetrics({
  servlet,
  scopeKey,
  serverName,
  applicationName,
  moduleId,
}: {
  servlet: DeploymentRequestServletMetric
  scopeKey: string | null | undefined
  serverName: string
  applicationName: string
  moduleId: string
}) {
  const resourceId = deploymentRequestServletResourceId(serverName, applicationName, moduleId, servlet.id)
  const invocationSeries = getMetricHistorySeries(
    scopeKey,
    DEPLOYMENT_REQUEST_METRIC_FAMILY,
    resourceId,
    DEPLOYMENT_REQUEST_INVOCATIONS_METRIC,
  )
  const executionSeries = getMetricHistorySeries(
    scopeKey,
    DEPLOYMENT_REQUEST_METRIC_FAMILY,
    resourceId,
    DEPLOYMENT_REQUEST_EXECUTION_TOTAL_METRIC,
  )

  return {
    intervalRequestRate: deriveRequestRate(invocationSeries).value,
    intervalAverageExecutionTime: deriveIntervalAverageExecutionTime(executionSeries, invocationSeries),
  }
}

export function sortDeploymentRequestServlets<T extends {
  servlet: DeploymentRequestServletMetric
  intervalRequestRate: number | null
}>(rows: T[]) {
  return [...rows].sort((a, b) => {
    const rateDelta = (b.intervalRequestRate ?? -1) - (a.intervalRequestRate ?? -1)
    if (rateDelta !== 0) return rateDelta
    const invocationDelta = (b.servlet.invocationTotalCount ?? -1) - (a.servlet.invocationTotalCount ?? -1)
    if (invocationDelta !== 0) return invocationDelta
    return a.servlet.name.localeCompare(b.servlet.name)
  })
}

export function useDeploymentRequestMetrics(serverName: string | null, applicationName: string | null) {
  const { creds } = useAuth()
  const livePollingInterval = useVisiblePollingInterval()
  const query = useQuery({
    queryKey: deploymentRequestMetricsQueryKey(creds, serverName, applicationName),
    enabled: deploymentRequestMetricsEnabled(creds, serverName, applicationName),
    staleTime: 0,
    refetchInterval: livePollingInterval,
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      if (!creds || !serverName || !applicationName) throw new Error('deployment request metrics query disabled')
      return fetchDeploymentRequestMetricsSnapshot(creds, serverName, applicationName)
    },
  })
  const samples = useMemo(() => projectDeploymentRequestMetricSamples(query.data), [query.data])
  const { scopeKey } = useMetricHistoryRecorder({
    creds,
    samples,
    timestamp: query.dataUpdatedAt,
    enabled: !!query.data,
  })

  useRefreshStaleQueryOnVisibleReturn({
    enabled: deploymentRequestMetricsEnabled(creds, serverName, applicationName),
    isFetching: query.isFetching,
    isStale: query.isStale,
    refetch: query.refetch,
  })

  return {
    ...query,
    scopeKey,
  }
}
