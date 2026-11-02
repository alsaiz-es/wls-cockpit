import type { StatusTone } from '../components/status-model.ts'

export type LogRecordSeverityGroup = 'error' | 'warning' | 'info' | 'other'

// Notice is informational in WebLogic (between Info and Warning); it is not an error.
export function logRecordSeverityGroup(value: string | null): LogRecordSeverityGroup {
  const normalized = value?.toLowerCase() ?? ''
  if (/critical|emergency|alert|error/.test(normalized)) return 'error'
  if (normalized.includes('warn')) return 'warning'
  if (normalized.includes('info') || normalized.includes('notice')) return 'info'
  return 'other'
}

export function logRecordSeverityTone(value: string | null): StatusTone {
  const normalized = value?.toLowerCase() ?? ''
  const group = logRecordSeverityGroup(value)
  if (group === 'error') return 'negative'
  if (group === 'warning') return 'warning'
  if (normalized.includes('notice')) return 'neutral'
  if (group === 'info') return 'positive'
  return 'unknown'
}
