import type { DashboardFamily, DashboardIssue, DashboardSnapshot } from '@/api/queries/domain-dashboard'
import { familyLabel, issueTarget } from './format'

export type DashboardLayoutMode = 'calm' | 'degraded' | 'critical' | 'partial'

export interface AffectedResourceSummary {
  label: string
  detail: string
  family: DashboardFamily | null
  targetLabel: string | null
  targetHref: string | null
}

export interface DashboardVisualModel {
  layoutMode: DashboardLayoutMode
  affected: AffectedResourceSummary
  compact: {
    issues: boolean
    jdbc: boolean
    logs: boolean
  }
  emphasize: {
    issueQueue: boolean
    affectedResources: boolean
  }
}

function issueResource(issue: DashboardIssue) {
  return issue.resourceName ?? issue.serverName ?? familyLabel(issue.family)
}

function primaryIssue(issues: DashboardIssue[]) {
  return [...issues].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1
    const familyOrder = a.family.localeCompare(b.family)
    if (familyOrder !== 0) return familyOrder
    return issueResource(a).localeCompare(issueResource(b), undefined, { numeric: true, sensitivity: 'base' })
  })[0]
}

function layoutMode(snapshot: DashboardSnapshot): DashboardLayoutMode {
  if (snapshot.severity === 'critical') return 'critical'
  if (snapshot.severity === 'warning') return 'degraded'
  if (snapshot.partialFailures.length > 0) return 'partial'
  return 'calm'
}

function affectedSummary(snapshot: DashboardSnapshot): AffectedResourceSummary {
  const issue = primaryIssue(snapshot.issues)

  if (!issue) {
    return {
      label: 'No active issues',
      detail: 'All available runtime signals are healthy.',
      family: null,
      targetLabel: null,
      targetHref: null,
    }
  }

  const target = issueTarget(issue)
  return {
    label: issueResource(issue),
    detail: `${familyLabel(issue.family)} · ${issue.detail}`,
    family: issue.family,
    targetLabel: target.label,
    targetHref: target.href,
  }
}

export function buildDashboardVisualModel(snapshot: DashboardSnapshot): DashboardVisualModel {
  const mode = layoutMode(snapshot)
  const hasIssues = snapshot.issues.length > 0
  const hasPartialFailures = snapshot.partialFailures.length > 0

  return {
    layoutMode: mode,
    affected: affectedSummary(snapshot),
    compact: {
      issues: !hasIssues && !hasPartialFailures && mode === 'calm',
      jdbc: snapshot.jdbc.status === 'empty' && mode === 'calm',
      logs: snapshot.logs.status === 'empty' && mode === 'calm',
    },
    emphasize: {
      issueQueue: mode === 'degraded' || mode === 'critical',
      affectedResources: hasIssues || hasPartialFailures,
    },
  }
}
