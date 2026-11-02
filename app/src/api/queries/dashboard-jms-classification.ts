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

export function classifyDashboardJms(item: DashboardJmsClassifiable): DashboardJmsSeverity {
  const current = item.messagesCurrentCount ?? 0
  const pending = item.messagesPendingCount ?? 0
  const consumers = item.consumersCurrentCount
  const hasMessages = current > 0 || pending > 0

  if ((hasDashboardJmsPauseSignal(item) && hasMessages) || hasDashboardJmsFailureSignal(item)) return 'critical'
  if ((item.destinationName && current > 0 && consumers === 0) || hasMessages || hasDashboardJmsPauseSignal(item)) {
    return 'warning'
  }
  return 'healthy'
}
