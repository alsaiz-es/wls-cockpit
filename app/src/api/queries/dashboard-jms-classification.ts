import {
  alertRuleLevel,
  getActiveAlertRules,
  worseAlertLevel,
  type AlertLevel,
  type ResolvedAlertRules,
} from '../alert-rules.ts'

export type DashboardJmsSeverity = 'healthy' | 'warning' | 'critical'

export interface DashboardJmsClassifiable {
  destinationName: string | null
  state: string | null
  messagesCurrentCount: number | null
  messagesPendingCount: number | null
  consumersCurrentCount: number | null
  consumptionPaused: boolean | null
  productionPaused: boolean | null
  insertionPaused: boolean | null
  consumptionPausedState: string | null
  productionPausedState: string | null
  insertionPausedState: string | null
}

function pauseStatePaused(value: string | null) {
  return typeof value === 'string' && value.toLowerCase().includes('paused')
}

export function hasDashboardJmsPauseSignal(item: DashboardJmsClassifiable) {
  return (
    item.consumptionPaused === true ||
    item.productionPaused === true ||
    item.insertionPaused === true ||
    pauseStatePaused(item.consumptionPausedState) ||
    pauseStatePaused(item.productionPausedState) ||
    pauseStatePaused(item.insertionPausedState)
  )
}

export function hasDashboardJmsFailureSignal(item: Pick<DashboardJmsClassifiable, 'state'>) {
  const state = item.state?.toLowerCase() ?? ''
  return state.includes('fail') || state.includes('overflow') || state.includes('overload') || state.includes('error')
}

// Pause and failure states are immediate. Message counts follow the jms.noConsumers and
// jms.backlog thresholds; a destination with messages and consumers is healthy below the backlog
// threshold, because that is normal traffic.
export function jmsStateLevel(item: DashboardJmsClassifiable): AlertLevel | null {
  const hasMessages = (item.messagesCurrentCount ?? 0) > 0 || (item.messagesPendingCount ?? 0) > 0
  if ((hasDashboardJmsPauseSignal(item) && hasMessages) || hasDashboardJmsFailureSignal(item)) return 'critical'
  if (hasDashboardJmsPauseSignal(item)) return 'warning'
  return null
}

export function jmsBacklog(item: Pick<DashboardJmsClassifiable, 'messagesCurrentCount' | 'messagesPendingCount'>) {
  if (item.messagesCurrentCount === null && item.messagesPendingCount === null) return null
  return (item.messagesCurrentCount ?? 0) + (item.messagesPendingCount ?? 0)
}

// Messages without consumers only make sense for a destination; a JMS server row has no consumers.
export function jmsNoConsumerMessages(item: DashboardJmsClassifiable) {
  return item.destinationName && item.consumersCurrentCount === 0 ? item.messagesCurrentCount : null
}

export function classifyDashboardJms(
  item: DashboardJmsClassifiable,
  rules: ResolvedAlertRules = getActiveAlertRules(),
): DashboardJmsSeverity {
  const level = worseAlertLevel(
    jmsStateLevel(item),
    alertRuleLevel(rules.rules['jms.noConsumers'], jmsNoConsumerMessages(item)),
    alertRuleLevel(rules.rules['jms.backlog'], jmsBacklog(item)),
  )
  return level ?? 'healthy'
}
