import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ADAPTIVE_POLL_FAST_INTERVAL_MS,
  ADAPTIVE_POLL_SLOW_INTERVAL_MS,
  createAdaptivePollingInterval,
  getDocumentVisibleSnapshot,
  pollingIntervalForVisibility,
  shouldRefreshStaleQueryOnVisibleReturn,
  subscribeToDocumentVisibility,
} from '../src/api/query-polling.ts'

test('document visibility treats non-browser contexts as visible', () => {
  const originalDocument = globalThis.document
  Reflect.deleteProperty(globalThis, 'document')

  try {
    assert.equal(getDocumentVisibleSnapshot(), true)
  } finally {
    if (originalDocument !== undefined) {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      })
    }
  }
})

test('document visibility subscription emits and cleans up visibility changes', () => {
  const originalDocument = globalThis.document
  const listeners = new Set<() => void>()
  let hidden = false

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      get hidden() {
        return hidden
      },
      addEventListener(event: string, listener: () => void) {
        if (event === 'visibilitychange') listeners.add(listener)
      },
      removeEventListener(event: string, listener: () => void) {
        if (event === 'visibilitychange') listeners.delete(listener)
      },
    },
  })

  try {
    let emitted = 0
    const unsubscribe = subscribeToDocumentVisibility(() => {
      emitted += 1
    })

    assert.equal(getDocumentVisibleSnapshot(), true)
    hidden = true
    listeners.forEach((listener) => listener())

    assert.equal(getDocumentVisibleSnapshot(), false)
    assert.equal(emitted, 1)

    unsubscribe()
    hidden = false
    listeners.forEach((listener) => listener())

    assert.equal(emitted, 1)
    assert.equal(listeners.size, 0)
  } finally {
    if (originalDocument === undefined) Reflect.deleteProperty(globalThis, 'document')
    else {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      })
    }
  }
})

test('visibility-derived polling interval disables automatic hidden-tab polling', () => {
  assert.equal(pollingIntervalForVisibility(true, 10_000), 10_000)
  assert.equal(pollingIntervalForVisibility(false, 10_000), false)
})

test('visible return refresh helper only refreshes stale data after hidden state', () => {
  assert.equal(shouldRefreshStaleQueryOnVisibleReturn(false, true, true), true)
  assert.equal(shouldRefreshStaleQueryOnVisibleReturn(false, true, false), false)
  assert.equal(shouldRefreshStaleQueryOnVisibleReturn(true, true, true), false)
  assert.equal(shouldRefreshStaleQueryOnVisibleReturn(false, false, true), false)
})

test('adaptive polling stays fast for active or recently changed snapshots then slows when stable', () => {
  const interval = createAdaptivePollingInterval<{ running: boolean; value: string }>({
    initialIntervalMs: ADAPTIVE_POLL_SLOW_INTERVAL_MS,
    isActiveSnapshot: (snapshot) => snapshot.running,
    getSnapshotKey: (snapshot) => snapshot.value,
  })

  assert.equal(interval(undefined), ADAPTIVE_POLL_SLOW_INTERVAL_MS)
  assert.equal(interval({ running: true, value: 'a' }), ADAPTIVE_POLL_FAST_INTERVAL_MS)
  assert.equal(interval({ running: false, value: 'b' }), ADAPTIVE_POLL_FAST_INTERVAL_MS)
  assert.equal(interval({ running: false, value: 'b' }), ADAPTIVE_POLL_FAST_INTERVAL_MS)
  assert.equal(interval({ running: false, value: 'b' }), ADAPTIVE_POLL_SLOW_INTERVAL_MS)
  assert.equal(interval({ running: false, value: 'c' }), ADAPTIVE_POLL_FAST_INTERVAL_MS)
})
