// Log views show the time of day to the millisecond (docs/ui/guidelines.md §10) and mark day changes
// with a separator row, so each record stays on one line. The full local date is in the tooltip.

function pad(value: number, width = 2) {
  return String(value).padStart(width, '0')
}

export function logClockTime(timestamp: number) {
  const date = new Date(timestamp)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

export function logDayKey(timestamp: number) {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function logDayLabel(timestamp: number) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export function logFullTimestamp(timestamp: number) {
  return new Date(timestamp).toLocaleString(undefined, { timeZoneName: 'short' })
}

interface TimedRecord {
  timestamp: number | null
  date?: string | null
}

// The cell text and tooltip for a record's time. Records without a parsed timestamp keep the raw
// date WebLogic sent.
export function logRecordTime(record: TimedRecord) {
  if (record.timestamp === null) {
    const raw = record.date ?? '–'
    return { text: raw, title: raw }
  }
  return { text: logClockTime(record.timestamp), title: logFullTimestamp(record.timestamp) }
}

// The day label to show above the record at index, or null when it is the same day as the record
// above it. Records without a timestamp never open a new day.
export function logDaySeparator(records: TimedRecord[], index: number) {
  const timestamp = records[index]?.timestamp ?? null
  if (timestamp === null) return null
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    const previousTimestamp = records[previous].timestamp
    if (previousTimestamp === null) continue
    return logDayKey(previousTimestamp) === logDayKey(timestamp) ? null : logDayLabel(timestamp)
  }
  return logDayLabel(timestamp)
}
