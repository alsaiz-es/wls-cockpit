import { serverDebugFlagLabel, type ServerDebugSnapshot } from '../api/queries/server-debug.ts'

// Debug flags are read-only in demo read-only mode, which removes Apply and Turn all off.
export function debugFlagsEditable(snapshot: Pick<ServerDebugSnapshot, 'flags'> | null, options: { readOnlyDemoMode?: boolean } = {}) {
  return !options.readOnlyDemoMode && !!snapshot && Object.keys(snapshot.flags).length > 0
}

export function debugChangeSummary(changes: Record<string, boolean>) {
  return Object.entries(changes)
    .map(([attribute, value]) => `${serverDebugFlagLabel(attribute)} ${value ? 'on' : 'off'}`)
    .join(', ')
}
