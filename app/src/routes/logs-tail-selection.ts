import { isLogSeverityFloor, type LogSeverityFloor } from '../api/queries/log-tail.ts'

// The Global Tail selection survives navigating away from Logs (the side nav drops the URL
// query), scoped to the connection profile and the browser tab.
const STORAGE_PREFIX = 'wls-cockpit:logs-tail:'

export interface LogsTailSelection {
  sourceIds: string[]
  severityFloor: LogSeverityFloor
}

type StorageArea = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const EMPTY_SELECTION: LogsTailSelection = { sourceIds: [], severityFloor: 'all' }

function browserSessionStorage(): StorageArea | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

export function readLogsTailSelection(
  profileId: string | null | undefined,
  storage: StorageArea | null = browserSessionStorage(),
): LogsTailSelection {
  if (!profileId || !storage) return EMPTY_SELECTION
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_PREFIX + profileId) ?? 'null') as Partial<LogsTailSelection> | null
    if (!parsed) return EMPTY_SELECTION
    return {
      sourceIds: Array.isArray(parsed.sourceIds)
        ? parsed.sourceIds.filter((id): id is string => typeof id === 'string')
        : [],
      severityFloor: isLogSeverityFloor(parsed.severityFloor) ? parsed.severityFloor : 'all',
    }
  } catch {
    return EMPTY_SELECTION
  }
}

export function writeLogsTailSelection(
  profileId: string | null | undefined,
  selection: LogsTailSelection,
  storage: StorageArea | null = browserSessionStorage(),
) {
  if (!profileId || !storage) return
  if (selection.sourceIds.length === 0 && selection.severityFloor === 'all') {
    storage.removeItem(STORAGE_PREFIX + profileId)
    return
  }
  storage.setItem(STORAGE_PREFIX + profileId, JSON.stringify(selection))
}
