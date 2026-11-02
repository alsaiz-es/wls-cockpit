export interface DashboardJmsDestinationScanSummary {
  destinationsCurrentCount: number | null
  messagesCurrentCount: number | null
  messagesPendingCount: number | null
  consumptionPaused: boolean | null
  productionPaused: boolean | null
  insertionPaused: boolean | null
  consumptionPausedState: string | null
  productionPausedState: string | null
  insertionPausedState: string | null
}

function isPausedState(value: string | null) {
  return !!value && value.toLowerCase().includes('paused')
}

export function hasJmsPauseSignal(item: DashboardJmsDestinationScanSummary) {
  return (
    item.consumptionPaused === true ||
    item.productionPaused === true ||
    item.insertionPaused === true ||
    isPausedState(item.consumptionPausedState) ||
    isPausedState(item.productionPausedState) ||
    isPausedState(item.insertionPausedState)
  )
}

export function shouldFetchJmsDestinations(item: DashboardJmsDestinationScanSummary) {
  if (hasJmsPauseSignal(item)) return true
  if ((item.messagesCurrentCount ?? 0) > 0) return true
  if ((item.messagesPendingCount ?? 0) > 0) return true
  if ((item.destinationsCurrentCount ?? 0) > 0) return true
  if (
    (item.messagesCurrentCount === null || item.messagesPendingCount === null) &&
    item.destinationsCurrentCount !== 0
  ) {
    return true
  }
  return false
}
