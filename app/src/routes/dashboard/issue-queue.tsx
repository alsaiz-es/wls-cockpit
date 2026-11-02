import { Link } from 'react-router-dom'
import type { DashboardIssue } from '@/api/queries/domain-dashboard'
import { Button } from '@/components/ui/button'
import { MonoText, StatusBadge } from '@/components'
import { familyLabel, issueHint, issueSecondaryTarget, issueSnapshotServers, issueTarget, severityTone } from './format'

function issueResource(issue: DashboardIssue) {
  return issue.resourceName ?? issue.serverName ?? issue.family
}

export function IssueQueue({
  issues,
  compact = false,
  onSnapshotIssue,
}: {
  issues: DashboardIssue[]
  compact?: boolean
  onSnapshotIssue?: (issue: DashboardIssue) => void
}) {
  if (issues.length === 0) {
    return (
      <div className="text-muted-foreground flex min-h-10 items-center justify-between gap-3 border-y border-border py-2">
        <span>No active issues detected.</span>
        {compact ? <span className="font-mono text-xs">OK</span> : null}
      </div>
    )
  }

  const ordered = [...issues].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1
    const familyOrder = a.family.localeCompare(b.family)
    if (familyOrder !== 0) return familyOrder
    return issueResource(a).localeCompare(issueResource(b), undefined, { numeric: true, sensitivity: 'base' })
  })

  return (
    <div className="overflow-auto border-b border-border">
      <table className="w-full min-w-[1040px] border-collapse tabular-nums">
        <thead>
          <tr className="h-9 border-b border-border">
            <th scope="col" className="text-muted-foreground px-3 text-left text-[13px] font-medium uppercase tracking-[0.04em]">
              Severity
            </th>
            <th scope="col" className="text-muted-foreground px-3 text-left text-[13px] font-medium uppercase tracking-[0.04em]">
              Family
            </th>
            <th scope="col" className="text-muted-foreground px-3 text-left text-[13px] font-medium uppercase tracking-[0.04em]">
              Resource
            </th>
            <th scope="col" className="text-muted-foreground px-3 text-left text-[13px] font-medium uppercase tracking-[0.04em]">
              Reason
            </th>
            <th scope="col" className="text-muted-foreground px-3 text-left text-[13px] font-medium uppercase tracking-[0.04em]">
              Target
            </th>
            <th scope="col" className="text-muted-foreground px-3 text-left text-[13px] font-medium uppercase tracking-[0.04em]">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {ordered.slice(0, 10).map((issue) => {
            const target = issueTarget(issue)
            const secondaryTarget = issueSecondaryTarget(issue)
            const snapshotServers = issueSnapshotServers(issue)
            const hint = issueHint(issue)
            return (
              <tr key={issue.id} className="h-9 border-t border-border hover:bg-surface-1">
                <td className="px-3">
                  <StatusBadge kind="custom" tone={severityTone(issue.severity)} label={issue.severity} />
                </td>
                <td className="px-3">
                  <MonoText>{familyLabel(issue.family)}</MonoText>
                </td>
                <td className="max-w-[220px] truncate px-3">
                  <MonoText title={issueResource(issue)}>{issueResource(issue)}</MonoText>
                </td>
                <td className="max-w-[460px] px-3 text-muted-foreground">
                  <span className="block truncate" title={issue.detail}>{issue.detail}</span>
                  <span className="text-subtle-foreground block truncate text-[12px]" title={hint}>
                    {hint}
                  </span>
                </td>
                <td className="max-w-[300px] px-3">
                  <Link
                    to={target.href}
                    title={target.label}
                    className="block h-7 truncate rounded-md px-2 text-[13px] leading-7 text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {target.label}
                  </Link>
                </td>
                <td className="px-3">
                  <div className="flex items-center gap-1">
                    {secondaryTarget ? (
                      <Link
                        to={secondaryTarget.href}
                        className="inline-flex h-7 items-center rounded-md px-2 text-[13px] text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {secondaryTarget.label}
                      </Link>
                    ) : null}
                    {onSnapshotIssue && snapshotServers.length > 0 ? (
                      <Button type="button" variant="ghost" size="xs" onClick={() => onSnapshotIssue(issue)}>
                        Snapshot
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {ordered.length > 10 ? (
        <div className="text-muted-foreground border-t border-border px-3 py-2 text-xs">
          {ordered.length - 10} more issues hidden in this overview.
        </div>
      ) : null}
    </div>
  )
}
