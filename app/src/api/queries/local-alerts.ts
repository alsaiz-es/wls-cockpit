import { useEffect, useSyncExternalStore } from 'react'
import { wlsCredentialCacheKey, type WlsCredentials } from '../client.ts'
import { applicationHealthDetail } from './deployment-health-symptoms.ts'
import type { DashboardSnapshot, DashboardSeverity } from './domain-dashboard.ts'
import {
  jdbcMetricResourceId,
  jmsMetricResourceId,
  metricResourceId,
  serverMetricResourceId,
} from './metric-history.ts'

export const LOCAL_ALERT_FAMILY_AGGREGATION_CAP = 5
export const LOCAL_ALERT_LOG_LIMIT = 200
export const LOCAL_ALERT_TOAST_LIMIT = 20

export type LocalAlertFamily = 'servers' | 'applications' | 'jdbc' | 'jms'
export type LocalAlertSeverity = 'critical' | 'warning' | 'info'
export type LocalAlertEventKind = 'alert' | 'recovery'
export type DesktopNotificationPermission = 'default' | 'granted' | 'denied' | 'unsupported'

export interface LocalAlertCondition {
  id: string
  family: LocalAlertFamily
  resourceId: string
  resourceLabel: string
  condition: string
  severity: Exclude<LocalAlertSeverity, 'info'>
  title: string
  detail: string
  route?: string
}

export interface LocalAlertActiveCondition {
  condition: LocalAlertCondition
  firstSeenAt: number
  lastSeenAt: number
  acknowledgedAt?: number
}

export interface LocalAlertEvent {
  id: string
  kind: LocalAlertEventKind
  family: LocalAlertFamily
  severity: LocalAlertSeverity
  title: string
  detail: string
  timestamp: number
  conditionIds: string[]
  resourceLabels: string[]
  count: number
  aggregate: boolean
  silent: boolean
  read: boolean
  route?: string
}

export interface LocalAlertToast {
  id: string
  eventId: string
  kind: LocalAlertEventKind
  severity: LocalAlertSeverity
  title: string
  detail: string
  createdAt: number
  autoDismissMs: number
}

export interface LocalAlertState {
  scopeKey: string | null
  baselineReady: boolean
  activeConditions: Record<string, LocalAlertActiveCondition>
  log: LocalAlertEvent[]
  toasts: LocalAlertToast[]
  desktopNotifications: {
    supported: boolean
    enabled: boolean
    permission: DesktopNotificationPermission
  }
}

export interface LocalAlertEvaluationResult {
  state: LocalAlertState
  emittedEvents: LocalAlertEvent[]
}

type LocalAlertSubscriber = () => void

interface BrowserNotificationConstructor {
  permission: NotificationPermission
  requestPermission?: () => Promise<NotificationPermission>
  new(title: string, options?: NotificationOptions): Notification
}

function desktopNotificationConstructor(): BrowserNotificationConstructor | null {
  if (typeof globalThis.Notification === 'undefined') return null
  return globalThis.Notification as BrowserNotificationConstructor
}

export function localAlertScopeKey(creds: WlsCredentials | null | undefined) {
  return creds ? wlsCredentialCacheKey(creds) : null
}

export function emptyLocalAlertState(scopeKey: string | null = null): LocalAlertState {
  const notificationApi = desktopNotificationConstructor()
  return {
    scopeKey,
    baselineReady: false,
    activeConditions: {},
    log: [],
    toasts: [],
    desktopNotifications: {
      supported: !!notificationApi,
      enabled: false,
      permission: notificationApi?.permission ?? 'unsupported',
    },
  }
}

function dashboardSeverityToAlertSeverity(severity: DashboardSeverity): Exclude<LocalAlertSeverity, 'info'> {
  return severity === 'critical' ? 'critical' : 'warning'
}

function conditionId(family: LocalAlertFamily, resourceId: string, condition: string) {
  return [family, resourceId, condition].map(encodeURIComponent).join('|')
}

function segment(value: string) {
  return encodeURIComponent(value)
}

function serverFailureCondition(snapshot: DashboardSnapshot): LocalAlertCondition[] {
  return snapshot.servers.flatMap((server) => {
    const state = server.state.toLowerCase()
    const health = server.healthState.toLowerCase()
    const failedState = state.includes('failed')
    const failedHealth = health === 'failed' || health === 'critical' || health === 'overloaded'
    if (!failedState && !failedHealth) return []

    const resourceId = serverMetricResourceId(server.name)
    return [{
      id: conditionId('servers', resourceId, 'server-failure'),
      family: 'servers',
      resourceId,
      resourceLabel: server.name,
      condition: 'server-failure',
      severity: 'critical',
      title: `${server.name} server failure`,
      detail: `Lifecycle ${server.state}, health ${server.healthState}.`,
      route: `/servers/${segment(server.name)}`,
    }]
  })
}

function deploymentFailureConditions(snapshot: DashboardSnapshot): LocalAlertCondition[] {
  return snapshot.applications.items.flatMap((app) => {
    const healthFailed =
      app.healthState === 'failed' ||
      app.healthState === 'critical' ||
      app.overallHealthState === 'failed' ||
      app.overallHealthState === 'critical'
    const deploymentFailed = String(app.deploymentState ?? '').toLowerCase().includes('fail')
    if (!healthFailed && !deploymentFailed && app.severity !== 'critical') return []

    const resourceId = metricResourceId('deployment', app.serverName, app.deploymentName)
    return [{
      id: conditionId('applications', resourceId, 'deployment-failure'),
      family: 'applications',
      resourceId,
      resourceLabel: app.name,
      condition: 'deployment-failure',
      severity: 'critical',
      title: `${app.name} deployment failure`,
      detail: applicationHealthDetail(app),
      route: `/deployments/${segment(app.serverName)}/${segment(app.deploymentName)}`,
    }]
  })
}

function jdbcPressureConditions(snapshot: DashboardSnapshot): LocalAlertCondition[] {
  return snapshot.jdbc.items.flatMap((pool) => {
    if (pool.severity !== 'critical') return []
    const resourceId = jdbcMetricResourceId(pool.serverName, pool.name)
    return [{
      id: conditionId('jdbc', resourceId, 'datasource-pressure'),
      family: 'jdbc',
      resourceId,
      resourceLabel: pool.name,
      condition: 'datasource-pressure',
      severity: 'critical',
      title: `${pool.name} datasource pressure`,
      detail: `State ${pool.state}, waiting ${pool.waitingForConnectionCurrentCount ?? 'n/a'}, leaked ${pool.leakedConnectionCount ?? 'n/a'}.`,
      route: `/data-sources/${segment(pool.serverName)}/${segment(pool.name)}`,
    }]
  })
}

function jmsPressureConditions(snapshot: DashboardSnapshot): LocalAlertCondition[] {
  return snapshot.jms.items.flatMap((item) => {
    if (item.severity === 'healthy' || item.severity === 'unknown') return []
    const resourceLabel = item.destinationName ?? item.jmsServerName
    const resourceId = jmsMetricResourceId(item.serverName, item.jmsServerName, item.destinationName)
    const route = item.destinationName
      ? `/jms/${segment(item.serverName)}/${segment(item.jmsServerName)}/${segment(item.destinationName)}`
      : '/jms'

    return [{
      id: conditionId('jms', resourceId, 'jms-pressure'),
      family: 'jms',
      resourceId,
      resourceLabel,
      condition: 'jms-pressure',
      severity: dashboardSeverityToAlertSeverity(item.severity),
      title: `${resourceLabel} JMS pressure`,
      detail: `Messages ${item.messagesCurrentCount ?? 'n/a'}, pending ${item.messagesPendingCount ?? 'n/a'}, consumers ${item.consumersCurrentCount ?? 'n/a'}, paused ${item.consumptionPaused || item.productionPaused || item.insertionPaused ? 'yes' : 'no'}.`,
      route,
    }]
  })
}

export function projectDashboardAlertConditions(snapshot: DashboardSnapshot): LocalAlertCondition[] {
  return [
    ...serverFailureCondition(snapshot),
    ...deploymentFailureConditions(snapshot),
    ...jdbcPressureConditions(snapshot),
    ...jmsPressureConditions(snapshot),
  ].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1
    if (a.family !== b.family) return a.family.localeCompare(b.family)
    return a.resourceLabel.localeCompare(b.resourceLabel, undefined, { numeric: true, sensitivity: 'base' })
  })
}

function familyLabel(family: LocalAlertFamily) {
  if (family === 'servers') return 'servers'
  if (family === 'applications') return 'deployments'
  if (family === 'jdbc') return 'datasources'
  return 'JMS resources'
}

function strongestSeverity(conditions: LocalAlertCondition[]): Exclude<LocalAlertSeverity, 'info'> {
  return conditions.some((condition) => condition.severity === 'critical') ? 'critical' : 'warning'
}

function severityRank(severity: Exclude<LocalAlertSeverity, 'info'>) {
  return severity === 'critical' ? 2 : 1
}

function conditionWorsened(previous: LocalAlertCondition, current: LocalAlertCondition) {
  return severityRank(current.severity) > severityRank(previous.severity)
}

function eventId(kind: LocalAlertEventKind, conditionIds: string[], timestamp: number) {
  return `${kind}:${timestamp}:${conditionIds.join(',')}`
}

function summarizeResources(conditions: LocalAlertCondition[]) {
  const labels = conditions.map((condition) => condition.resourceLabel)
  const visible = labels.slice(0, 3)
  const remaining = labels.length - visible.length
  return remaining > 0 ? `${visible.join(', ')} and ${remaining} more` : visible.join(', ')
}

function aggregateTitle(kind: LocalAlertEventKind, family: LocalAlertFamily, conditions: LocalAlertCondition[]) {
  const label = familyLabel(family)
  const state = kind === 'recovery' ? 'recovered' : strongestSeverity(conditions)
  return `${conditions.length} ${label} ${state}`
}

function aggregateDetail(kind: LocalAlertEventKind, conditions: LocalAlertCondition[]) {
  const prefix = kind === 'recovery' ? 'Recovered' : 'Affected'
  return `${prefix}: ${summarizeResources(conditions)}.`
}

function eventFromCondition(
  condition: LocalAlertCondition,
  kind: LocalAlertEventKind,
  timestamp: number,
  silent: boolean,
): LocalAlertEvent {
  return {
    id: eventId(kind, [condition.id], timestamp),
    kind,
    family: condition.family,
    severity: kind === 'recovery' ? 'info' : condition.severity,
    title: kind === 'recovery' ? `${condition.resourceLabel} recovered` : condition.title,
    detail: kind === 'recovery' ? `${condition.title} is no longer reported.` : condition.detail,
    timestamp,
    conditionIds: [condition.id],
    resourceLabels: [condition.resourceLabel],
    count: 1,
    aggregate: false,
    silent,
    read: false,
    route: condition.route,
  }
}

function aggregateEvent(
  conditions: LocalAlertCondition[],
  kind: LocalAlertEventKind,
  timestamp: number,
  silent: boolean,
): LocalAlertEvent {
  const family = conditions[0]?.family ?? 'servers'
  const conditionIds = conditions.map((condition) => condition.id)
  return {
    id: eventId(kind, conditionIds, timestamp),
    kind,
    family,
    severity: kind === 'recovery' ? 'info' : strongestSeverity(conditions),
    title: aggregateTitle(kind, family, conditions),
    detail: aggregateDetail(kind, conditions),
    timestamp,
    conditionIds,
    resourceLabels: conditions.map((condition) => condition.resourceLabel),
    count: conditions.length,
    aggregate: true,
    silent,
    read: false,
  }
}

function groupEvents(
  conditions: LocalAlertCondition[],
  kind: LocalAlertEventKind,
  timestamp: number,
  silent: boolean,
  aggregationCap: number,
) {
  const byFamily = new Map<LocalAlertFamily, LocalAlertCondition[]>()
  conditions.forEach((condition) => {
    byFamily.set(condition.family, [...(byFamily.get(condition.family) ?? []), condition])
  })

  return [...byFamily.values()].flatMap((familyConditions) => {
    if (familyConditions.length > aggregationCap) {
      return [aggregateEvent(familyConditions, kind, timestamp, silent)]
    }
    return familyConditions.map((condition) => eventFromCondition(condition, kind, timestamp, silent))
  })
}

function toastsForEvents(events: LocalAlertEvent[]): LocalAlertToast[] {
  return events
    .filter((event) => !event.silent)
    .map((event) => ({
      id: `toast:${event.id}`,
      eventId: event.id,
      kind: event.kind,
      severity: event.severity,
      title: event.title,
      detail: event.detail,
      createdAt: event.timestamp,
      autoDismissMs: event.kind === 'recovery' ? 4_000 : event.severity === 'critical' ? 9_000 : 6_000,
    }))
}

function mergeLog(log: LocalAlertEvent[], events: LocalAlertEvent[]) {
  return [...events, ...log].slice(0, LOCAL_ALERT_LOG_LIMIT)
}

function mergeToasts(toasts: LocalAlertToast[], next: LocalAlertToast[]) {
  return [...next, ...toasts].slice(0, LOCAL_ALERT_TOAST_LIMIT)
}

export function evaluateLocalAlertConditions(
  state: LocalAlertState,
  scopeKey: string | null,
  conditions: LocalAlertCondition[],
  timestamp: number,
  options: { aggregationCap?: number } = {},
): LocalAlertEvaluationResult {
  const aggregationCap = options.aggregationCap ?? LOCAL_ALERT_FAMILY_AGGREGATION_CAP
  if (state.scopeKey !== scopeKey) {
    state = emptyLocalAlertState(scopeKey)
  }

  const activeConditions = { ...state.activeConditions }
  const current = new Map(conditions.map((condition) => [condition.id, condition]))

  if (!state.baselineReady) {
    conditions.forEach((condition) => {
      activeConditions[condition.id] = { condition, firstSeenAt: timestamp, lastSeenAt: timestamp }
    })
    const baselineEvents = groupEvents(conditions, 'alert', timestamp, true, aggregationCap)
    return {
      emittedEvents: [],
      state: {
        ...state,
        baselineReady: true,
        activeConditions,
        log: mergeLog(state.log, baselineEvents),
      },
    }
  }

  const newConditions = conditions.filter((condition) => {
    const previous = activeConditions[condition.id]
    return !previous || conditionWorsened(previous.condition, condition)
  })
  const recoveredConditions = Object.values(activeConditions)
    .filter((active) => !current.has(active.condition.id))
    .map((active) => active.condition)

  conditions.forEach((condition) => {
    const previous = activeConditions[condition.id]
    const worsened = previous ? conditionWorsened(previous.condition, condition) : false
    activeConditions[condition.id] = {
      condition,
      firstSeenAt: previous?.firstSeenAt ?? timestamp,
      lastSeenAt: timestamp,
      acknowledgedAt: worsened ? undefined : previous?.acknowledgedAt,
    }
  })
  recoveredConditions.forEach((condition) => {
    delete activeConditions[condition.id]
  })

  const alertEvents = groupEvents(newConditions, 'alert', timestamp, false, aggregationCap)
  const recoveryEvents = groupEvents(recoveredConditions, 'recovery', timestamp, false, aggregationCap)
  const emittedEvents = [...alertEvents, ...recoveryEvents]

  return {
    emittedEvents,
    state: {
      ...state,
      activeConditions,
      log: mergeLog(state.log, emittedEvents),
      toasts: mergeToasts(state.toasts, toastsForEvents(emittedEvents)),
    },
  }
}

export function unreadLocalAlertCount(state: LocalAlertState) {
  return state.log.filter((event) => !event.read).length
}

export function activeLocalAlertCount(state: LocalAlertState) {
  return Object.keys(state.activeConditions).length
}

export function unacknowledgedLocalAlertCount(state: LocalAlertState) {
  return Object.values(state.activeConditions).filter((active) => active.acknowledgedAt == null).length
}

export function canSendDesktopNotifications(
  enabled: boolean,
  notificationApi: Pick<BrowserNotificationConstructor, 'permission'> | null = desktopNotificationConstructor(),
) {
  return !!enabled && !!notificationApi && notificationApi.permission === 'granted'
}

export function sendDesktopNotifications(
  events: LocalAlertEvent[],
  enabled: boolean,
  notificationApi: BrowserNotificationConstructor | null = desktopNotificationConstructor(),
) {
  if (!notificationApi || !canSendDesktopNotifications(enabled, notificationApi)) return 0
  return events.reduce((sent, event) => {
    if (event.silent) return sent
    new notificationApi(event.title, {
      body: event.detail,
      tag: event.id,
    })
    return sent + 1
  }, 0)
}

let localAlertState = emptyLocalAlertState()
const subscribers = new Set<LocalAlertSubscriber>()

function emitLocalAlertChange() {
  subscribers.forEach((subscriber) => subscriber())
}

export function subscribeToLocalAlerts(subscriber: LocalAlertSubscriber) {
  subscribers.add(subscriber)
  return () => subscribers.delete(subscriber)
}

export function getLocalAlertSnapshot() {
  return localAlertState
}

export function resetLocalAlerts(scopeKey: string | null = null) {
  localAlertState = emptyLocalAlertState(scopeKey)
  emitLocalAlertChange()
}

export function recordLocalAlertSnapshot(
  scopeKey: string | null,
  snapshot: DashboardSnapshot | null | undefined,
  timestamp: number,
) {
  if (!scopeKey || !snapshot || timestamp <= 0) return
  const result = evaluateLocalAlertConditions(
    localAlertState,
    scopeKey,
    projectDashboardAlertConditions(snapshot),
    timestamp,
  )
  localAlertState = result.state
  sendDesktopNotifications(
    result.emittedEvents,
    localAlertState.desktopNotifications.enabled,
  )
  emitLocalAlertChange()
}

export function dismissLocalAlertToast(toastId: string) {
  localAlertState = {
    ...localAlertState,
    toasts: localAlertState.toasts.filter((toast) => toast.id !== toastId),
  }
  emitLocalAlertChange()
}

export function markLocalAlertsRead() {
  if (localAlertState.log.every((event) => event.read)) return
  localAlertState = {
    ...localAlertState,
    log: localAlertState.log.map((event) => ({ ...event, read: true })),
  }
  emitLocalAlertChange()
}

export function acknowledgeActiveLocalAlerts(timestamp: number = Date.now()) {
  if (Object.values(localAlertState.activeConditions).every((active) => active.acknowledgedAt != null)) return
  localAlertState = {
    ...localAlertState,
    activeConditions: Object.fromEntries(
      Object.entries(localAlertState.activeConditions).map(([id, active]) => [
        id,
        { ...active, acknowledgedAt: active.acknowledgedAt ?? timestamp },
      ]),
    ),
  }
  emitLocalAlertChange()
}

export function clearRecoveredLocalAlerts() {
  localAlertState = {
    ...localAlertState,
    log: localAlertState.log.filter((event) => event.kind !== 'recovery'),
  }
  emitLocalAlertChange()
}

export async function setDesktopLocalAlertsEnabled(enabled: boolean) {
  const notificationApi = desktopNotificationConstructor()
  if (!notificationApi) {
    localAlertState = {
      ...localAlertState,
      desktopNotifications: { supported: false, enabled: false, permission: 'unsupported' },
    }
    emitLocalAlertChange()
    return localAlertState.desktopNotifications
  }

  let permission: DesktopNotificationPermission = notificationApi.permission
  if (enabled && permission === 'default' && notificationApi.requestPermission) {
    permission = await notificationApi.requestPermission()
  }

  localAlertState = {
    ...localAlertState,
    desktopNotifications: {
      supported: true,
      enabled: enabled && permission === 'granted',
      permission,
    },
  }
  emitLocalAlertChange()
  return localAlertState.desktopNotifications
}

export function useLocalAlertSnapshot() {
  return useSyncExternalStore(subscribeToLocalAlerts, getLocalAlertSnapshot, getLocalAlertSnapshot)
}

export function useRecordLocalRuntimeAlerts({
  creds,
  snapshot,
  timestamp,
}: {
  creds: WlsCredentials | null | undefined
  snapshot: DashboardSnapshot | null | undefined
  timestamp: number
}) {
  const scopeKey = localAlertScopeKey(creds)

  useEffect(() => {
    if (!scopeKey) {
      resetLocalAlerts(null)
      return
    }
    recordLocalAlertSnapshot(scopeKey, snapshot, timestamp)
  }, [scopeKey, snapshot, timestamp])
}
