import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { RefetchOptions, QueryObserverResult } from '@tanstack/react-query'

export type PollingInterval = number | false

export const DEFAULT_LIVE_POLL_INTERVAL_MS = 10_000
export const ADAPTIVE_POLL_FAST_INTERVAL_MS = 10_000
export const ADAPTIVE_POLL_SLOW_INTERVAL_MS = 60_000
export const DEFAULT_STABLE_SNAPSHOT_COUNT = 2

export function getDocumentVisibleSnapshot() {
  if (typeof document === 'undefined') return true
  return !document.hidden
}

export function subscribeToDocumentVisibility(onStoreChange: () => void) {
  if (typeof document === 'undefined') return () => {}

  document.addEventListener('visibilitychange', onStoreChange)
  return () => document.removeEventListener('visibilitychange', onStoreChange)
}

export function useDocumentVisible() {
  return useSyncExternalStore(subscribeToDocumentVisibility, getDocumentVisibleSnapshot, () => true)
}

export function pollingIntervalForVisibility(visible: boolean, intervalMs: number): PollingInterval {
  return visible ? intervalMs : false
}

export function useVisiblePollingInterval(intervalMs = DEFAULT_LIVE_POLL_INTERVAL_MS) {
  return pollingIntervalForVisibility(useDocumentVisible(), intervalMs)
}

export function shouldRefreshStaleQueryOnVisibleReturn(
  wasVisible: boolean,
  isVisible: boolean,
  isStale: boolean,
) {
  return !wasVisible && isVisible && isStale
}

export function useRefreshStaleQueryOnVisibleReturn<TData, TError>({
  enabled = true,
  isFetching,
  isStale,
  refetch,
}: {
  enabled?: boolean
  isFetching: boolean
  isStale: boolean
  refetch: (options?: RefetchOptions) => Promise<QueryObserverResult<TData, TError>>
}) {
  const visible = useDocumentVisible()
  const previousVisible = useRef(visible)

  useEffect(() => {
    if (
      enabled &&
      shouldRefreshStaleQueryOnVisibleReturn(previousVisible.current, visible, isStale) &&
      !isFetching
    ) {
      void refetch()
    }
    previousVisible.current = visible
  }, [enabled, isFetching, isStale, refetch, visible])
}

export interface AdaptivePollingOptions<TSnapshot> {
  fastIntervalMs?: number
  slowIntervalMs?: number
  initialIntervalMs?: number
  stableSnapshotCount?: number
  isActiveSnapshot?: (snapshot: TSnapshot) => boolean
  getSnapshotKey: (snapshot: TSnapshot) => string
}

export function createAdaptivePollingInterval<TSnapshot>({
  fastIntervalMs = ADAPTIVE_POLL_FAST_INTERVAL_MS,
  slowIntervalMs = ADAPTIVE_POLL_SLOW_INTERVAL_MS,
  initialIntervalMs = slowIntervalMs,
  stableSnapshotCount = DEFAULT_STABLE_SNAPSHOT_COUNT,
  isActiveSnapshot = () => false,
  getSnapshotKey,
}: AdaptivePollingOptions<TSnapshot>) {
  let previousSnapshotKey: string | null = null
  let stableSnapshots = 0

  return (snapshot: TSnapshot | null | undefined): number => {
    if (snapshot === null || snapshot === undefined) {
      previousSnapshotKey = null
      stableSnapshots = 0
      return initialIntervalMs
    }

    const snapshotKey = getSnapshotKey(snapshot)

    if (isActiveSnapshot(snapshot)) {
      previousSnapshotKey = snapshotKey
      stableSnapshots = 0
      return fastIntervalMs
    }

    if (previousSnapshotKey === snapshotKey) {
      stableSnapshots += 1
    } else {
      stableSnapshots = 0
    }

    previousSnapshotKey = snapshotKey
    return stableSnapshots >= stableSnapshotCount ? slowIntervalMs : fastIntervalMs
  }
}
