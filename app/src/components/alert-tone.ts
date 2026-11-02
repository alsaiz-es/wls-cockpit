import type { AlertLevel } from '@/api/alert-rules'

export function alertTextClass(level: AlertLevel | null | undefined) {
  if (level === 'critical') return 'text-status-negative'
  if (level === 'warning') return 'text-status-warning'
  return undefined
}
