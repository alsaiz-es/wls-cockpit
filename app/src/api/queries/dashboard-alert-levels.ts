import {
  formatAlertDuration,
  isAlertIgnored,
  sustainedAlertLevel,
  worseAlertLevel,
  type AlertLevel,
  type AlertSustainTracker,
  type ResolvedAlertRules,
} from '../alert-rules.ts'
import type { DashboardIssue } from './domain-dashboard.ts'
import type { HeapUsage } from './heap-utilization.ts'
import { heapUtilization } from './heap-utilization.ts'
import {
  capJdbcUtilizationLevel,
  jdbcStateLevel,
  jdbcUtilizationPercent,
  type JdbcPoolRuntime,
} from './dashboard-jdbc-normalization.ts'
import {
  jmsBacklog,
  jmsNoConsumerMessages,
  jmsStateLevel,
  type DashboardJmsClassifiable,
} from './dashboard-jms-classification.ts'

// The dashboard judges thresholded signals over time (see alert-rules.ts): a pool, destination or
// server only reaches a level once its reading has held for the rule's duration. States reported
// by WebLogic (overloaded, paused, failed) are immediate.

export interface DashboardAlertContext {
  rules: ResolvedAlertRules
  // Null for one-off snapshots: each reading is then judged on its own.
  tracker: AlertSustainTracker | null
  now: number
}

export function sustainedJdbcSeverity(pool: JdbcPoolRuntime, context: DashboardAlertContext): JdbcPoolRuntime['severity'] {
  const { rules, tracker, now } = context
  const key = `${pool.serverName}\u0000${pool.name}`
  const level = worseAlertLevel(
    jdbcStateLevel(pool),
    sustainedAlertLevel(tracker, `jdbc.waiting\u0000${key}`, rules.rules['jdbc.waiting'], pool.waitingForConnectionCurrentCount, now),
    capJdbcUtilizationLevel(
      sustainedAlertLevel(tracker, `jdbc.utilization\u0000${key}`, rules.rules['jdbc.utilization'], jdbcUtilizationPercent(pool), now),
      pool,
    ),
    tracker?.increaseLevel(`jdbc.leaked\u0000${key}`, rules.rules['jdbc.leaked'], pool.leakedConnectionCount, now),
  )
  return level ?? 'healthy'
}

export function sustainedJmsSeverity(
  item: DashboardJmsClassifiable & { serverName: string; jmsServerName: string },
  context: DashboardAlertContext,
): 'healthy' | AlertLevel {
  const { rules, tracker, now } = context
  const key = `${item.serverName}\u0000${item.jmsServerName}\u0000${item.destinationName ?? ''}`
  const level = worseAlertLevel(
    jmsStateLevel(item),
    sustainedAlertLevel(tracker, `jms.noConsumers\u0000${key}`, rules.rules['jms.noConsumers'], jmsNoConsumerMessages(item), now),
    sustainedAlertLevel(tracker, `jms.backlog\u0000${key}`, rules.rules['jms.backlog'], jmsBacklog(item), now),
  )
  return level ?? 'healthy'
}

export interface DashboardPressureServer {
  name: string
  heap: HeapUsage | null
  threads: {
    pending: number | null
    hogging: number | null
    stuck: number
    queueLength: number | null
  } | null
}

function snapshotServers(serverName: string) {
  return [serverName]
}

export function buildServerPressureIssues(servers: DashboardPressureServer[], context: DashboardAlertContext): DashboardIssue[] {
  const { rules, tracker, now } = context
  return servers.flatMap((server): DashboardIssue[] => {
    const issues: DashboardIssue[] = []

    if (server.threads) {
      const pending = server.threads.pending ?? 0
      const hogging = server.threads.hogging ?? 0
      const stuck = server.threads.stuck
      const queue = server.threads.queueLength ?? 0
      const stuckLevel = sustainedAlertLevel(tracker, `threads.stuck\u0000${server.name}`, rules.rules['threads.stuck'], stuck, now)
      const level = worseAlertLevel(
        sustainedAlertLevel(tracker, `threads.pending\u0000${server.name}`, rules.rules['threads.pending'], pending, now),
        sustainedAlertLevel(tracker, `threads.hogging\u0000${server.name}`, rules.rules['threads.hogging'], hogging, now),
        stuckLevel,
      )
      if (level) {
        issues.push({
          id: `threads:${server.name}`,
          severity: level,
          family: 'threads',
          title: `${server.name} has execution pressure`,
          detail: `Pending ${pending}, hogging ${hogging}, stuck ${stuck}, queue ${queue}.`,
          hint: stuckLevel
            ? 'Capture evidence and inspect thread detail/logs before restarting or clearing load.'
            : 'Inspect server metrics and logs to confirm whether execute-thread pressure is sustained.',
          serverName: server.name,
          snapshotServers: snapshotServers(server.name),
        })
      }
    }

    const heapFraction = heapUtilization(server.heap)
    const heapPercent = heapFraction === null ? null : heapFraction * 100
    const heapRule = rules.rules['heap.percent']
    const heapLevel = sustainedAlertLevel(tracker, `heap.percent\u0000${server.name}`, heapRule, heapPercent, now)
    if (heapLevel && heapPercent !== null) {
      issues.push({
        id: `heap:${server.name}`,
        severity: heapLevel,
        family: 'jvm',
        title: `${server.name} heap usage is high`,
        detail: tracker && heapRule.forMs > 0
          ? `Heap ${Math.round(heapPercent)}% of max for at least ${formatAlertDuration(heapRule.forMs)}.`
          : `Heap ${Math.round(heapPercent)}% of max.`,
        hint: 'Open server metrics to see whether heap drops after garbage collection before taking a heap dump.',
        serverName: server.name,
        snapshotServers: snapshotServers(server.name),
      })
    }

    return issues
  })
}

// Resources listed under ignore in alerts.yaml raise neither issues nor alerts.
export function isDashboardIssueIgnored(issue: DashboardIssue, rules: Pick<ResolvedAlertRules, 'ignore'>) {
  if (rules.ignore.length === 0) return false
  if (issue.family === 'jdbc') return isAlertIgnored(rules, 'jdbc', issue.resourceName)
  if (issue.family === 'jms') return isAlertIgnored(rules, 'jms', issue.destinationName, issue.jmsServerName, issue.resourceName)
  if (issue.family === 'applications') return isAlertIgnored(rules, 'deployments', issue.deploymentName, issue.resourceName)
  return isAlertIgnored(rules, 'servers', issue.serverName)
}
