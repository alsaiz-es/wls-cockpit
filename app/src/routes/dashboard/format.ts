import type { DashboardFamily, DashboardIssue, DashboardSeverity } from '@/api/queries/domain-dashboard'
import type { StatusTone } from '@/components'

export interface IssueTarget {
  label: string
  href: string
}

const issueTargets: Record<DashboardFamily, IssueTarget> = {
  servers: { label: 'Servers', href: '/servers' },
  jvm: { label: 'Servers', href: '/servers' },
  threads: { label: 'Servers', href: '/servers' },
  jdbc: { label: 'Data Sources', href: '/data-sources' },
  jms: { label: 'JMS target unavailable', href: '/dashboard' },
  applications: { label: 'Deployments', href: '/deployments' },
  logs: { label: 'Logs', href: '/logs' },
}

export function severityTone(severity: DashboardSeverity): StatusTone {
  if (severity === 'critical') return 'negative'
  if (severity === 'warning') return 'warning'
  if (severity === 'healthy') return 'positive'
  return 'unknown'
}

export function formatNumber(value: number | null | undefined) {
  return value === null || value === undefined ? '-' : value.toLocaleString()
}

export function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined) return '-'
  const percent = value * 100
  return percent >= 99 && percent < 100 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`
}

export function deploymentLabel(value: string | number | null) {
  if (value === null) return '-'
  if (value === 2) return 'ACTIVATED'
  return String(value)
}

function segment(value: string) {
  return encodeURIComponent(value)
}

function jmsListHref(issue: DashboardIssue) {
  const params = new URLSearchParams()
  if (issue.serverName) params.set('server', issue.serverName)
  if (issue.jmsServerName) params.set('jmsServer', issue.jmsServerName)
  const query = params.toString()
  return query ? `/jms?${query}` : '/jms'
}

export function issueTarget(issue: DashboardIssue): IssueTarget {
  const fallback = issueTargets[issue.family]

  if ((issue.family === 'servers' || issue.family === 'jvm' || issue.family === 'threads') && issue.serverName) {
    return { label: fallback.label, href: `/servers/${segment(issue.serverName)}` }
  }

  if (issue.family === 'jdbc' && issue.serverName && issue.resourceName) {
    return { label: fallback.label, href: `/data-sources/${segment(issue.serverName)}/${segment(issue.resourceName)}` }
  }

  if (issue.family === 'jms') {
    if (issue.serverName && issue.jmsServerName && issue.destinationName) {
      return {
        label: `JMS ${issue.destinationName}`,
        href: `/jms/${segment(issue.serverName)}/${segment(issue.jmsServerName)}/${segment(issue.destinationName)}`,
      }
    }
    if (issue.serverName && issue.jmsServerName) {
      return { label: `JMS ${issue.jmsServerName}`, href: jmsListHref(issue) }
    }
    return fallback
  }

  if (issue.family === 'applications' && issue.serverName) {
    const deploymentName = issue.deploymentName ?? issue.resourceName
    if (deploymentName) {
      return { label: fallback.label, href: `/deployments/${segment(issue.serverName)}/${segment(deploymentName)}` }
    }
  }

  if (issue.family === 'logs' && issue.serverName) {
    return { label: fallback.label, href: `/logs/${segment(issue.serverName)}` }
  }

  return fallback
}

export function issueSecondaryTarget(issue: DashboardIssue): IssueTarget | null {
  if (issue.family === 'logs') return null

  if (issue.serverName) {
    if (issue.family === 'servers' || issue.family === 'jvm' || issue.family === 'threads') {
      return { label: 'Logs', href: `/logs/${segment(issue.serverName)}` }
    }

    return { label: 'Server', href: `/servers/${segment(issue.serverName)}` }
  }

  return null
}

export function issueSnapshotServers(issue: DashboardIssue) {
  const servers = issue.snapshotServers?.length ? issue.snapshotServers : issue.serverName ? [issue.serverName] : []
  return Array.from(new Set(servers.map((server) => server.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b))
}

export function issueHint(issue: DashboardIssue) {
  if (issue.hint) return issue.hint
  if (issue.family === 'servers' || issue.family === 'jvm') return 'Open server detail to inspect lifecycle, health, JVM, and recent task signals.'
  if (issue.family === 'threads') return 'Inspect server metrics and logs before deciding on lifecycle action.'
  if (issue.family === 'jdbc') return 'Open datasource detail to inspect pool pressure and adjacent server signals.'
  if (issue.family === 'jms') return 'Open JMS detail to inspect backlog, consumers, pause state, and message tooling support.'
  if (issue.family === 'applications') return 'Open deployment detail to inspect runtime health, request metrics, and targets.'
  if (issue.family === 'logs') return 'Open the server log route to verify availability and inspect recent records.'
  return 'Open the diagnostic target for the most specific available signal.'
}

export function familyLabel(family: DashboardFamily) {
  if (family === 'jdbc') return 'JDBC'
  if (family === 'jms') return 'JMS'
  if (family === 'jvm') return 'JVM'
  return family.charAt(0).toUpperCase() + family.slice(1)
}
