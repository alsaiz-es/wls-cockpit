import type { UserLockoutServerRow } from '@/api/queries/user-lockout'
import type { StatusTone } from '@/components/status-model'

export interface SecurityActionModeOptions {
  readOnlyDemoMode?: boolean
}

// Servers a lockout is cleared on: every one whose security runtime answered. Empty in read-only
// demo mode, which removes the action.
export function lockoutClearServers(rows: UserLockoutServerRow[], options: SecurityActionModeOptions = {}) {
  if (options.readOnlyDemoMode) return []
  return rows.filter((row) => row.available).map((row) => row.serverName)
}

export function lockoutRowTone(row: UserLockoutServerRow): StatusTone {
  if (!row.available) return 'unknown'
  return (row.lockedUsersCurrentCount ?? 0) > 0 ? 'warning' : 'positive'
}
