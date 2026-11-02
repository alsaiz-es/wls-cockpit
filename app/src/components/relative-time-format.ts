export function toRelativeDate(value: Date | number | string | null | undefined) {
  if (value === null || value === undefined || value === 0) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatRelativeTime(date: Date, now: number) {
  const deltaSeconds = Math.max(0, Math.floor((now - date.getTime()) / 1000))
  // The shared clock ticks every 30 s, so a seconds count would sit frozen at '0s ago' (and a
  // timestamp newer than the last tick would read 0 s too). Under a minute is 'just now'.
  if (deltaSeconds < 60) return 'just now'

  const deltaMinutes = Math.floor(deltaSeconds / 60)
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`

  const deltaHours = Math.floor(deltaMinutes / 60)
  if (deltaHours < 24) return `${deltaHours}h ago`

  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
