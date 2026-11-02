import type { JmsRuntimeSummary } from './domain-dashboard.ts'
import type { ServerRuntimeRow } from './server-runtimes.ts'

export interface DashboardServerJmsPressure {
  messages: number | null
  pending: number | null
  issues: number
}

export function dashboardServerJmsPressure(
  server: Pick<ServerRuntimeRow, 'state'>,
  jmsItems: Array<Pick<JmsRuntimeSummary, 'messagesCurrentCount' | 'messagesPendingCount' | 'severity'>>,
): DashboardServerJmsPressure {
  const issues = jmsItems.filter((item) => item.severity === 'critical' || item.severity === 'warning').length
  if (server.state !== 'RUNNING') {
    return {
      messages: null,
      pending: null,
      issues,
    }
  }

  return {
    messages: jmsItems.reduce((total, item) => total + (item.messagesCurrentCount ?? 0), 0),
    pending: jmsItems.reduce((total, item) => total + (item.messagesPendingCount ?? 0), 0),
    issues,
  }
}
