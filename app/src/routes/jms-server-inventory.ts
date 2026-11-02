import type { JmsDestinationRow } from '../api/queries/jms-normalization.ts'

export interface JmsServerInventoryRow {
  id: string
  serverName: string
  jmsServerName: string
  destinations: number
  messages: number
  pending: number
  consumers: number
  // Destinations holding messages that nobody consumes.
  stalled: number
}

// A large OSB domain lists dozens of destinations; this answers "which JMS server holds what"
// before scrolling the destination table.
export function jmsServerInventory(rows: Pick<
  JmsDestinationRow,
  'serverName' | 'jmsServerName' | 'destinationName' | 'messagesCurrentCount' | 'messagesPendingCount' | 'consumersCurrentCount'
>[]): JmsServerInventoryRow[] {
  const byServer = new Map<string, JmsServerInventoryRow>()
  rows.forEach((row) => {
    const id = `${row.serverName}/${row.jmsServerName}`
    const entry = byServer.get(id) ?? {
      id,
      serverName: row.serverName,
      jmsServerName: row.jmsServerName,
      destinations: 0,
      messages: 0,
      pending: 0,
      consumers: 0,
      stalled: 0,
    }
    if (row.destinationName) {
      entry.destinations += 1
      entry.messages += row.messagesCurrentCount ?? 0
      entry.pending += row.messagesPendingCount ?? 0
      entry.consumers += row.consumersCurrentCount ?? 0
      if ((row.messagesCurrentCount ?? 0) > 0 && row.consumersCurrentCount === 0) entry.stalled += 1
    }
    byServer.set(id, entry)
  })
  return [...byServer.values()].sort(
    (a, b) => a.serverName.localeCompare(b.serverName) || a.jmsServerName.localeCompare(b.jmsServerName),
  )
}
