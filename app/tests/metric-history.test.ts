import assert from 'node:assert/strict'
import test from 'node:test'
import {
  METRIC_HISTORY_GAP_MS,
  METRIC_HISTORY_RETENTION_MS,
  getMetricHistorySeries,
  jdbcMetricResourceId,
  metricHistoryScopeKey,
  recordMetricSample,
  recordMetricSamples,
  resetMetricHistory,
  resetMetricHistoryScopeOnChange,
  serverMetricResourceId,
} from '../src/api/queries/metric-history.ts'
import type { WlsCredentials } from '../src/api/client.ts'

function creds(overrides: Partial<WlsCredentials> = {}): WlsCredentials {
  return {
    profileId: 'lab',
    name: 'Lab',
    targetUrl: 'http://wls-admin.example.com:7001',
    username: 'admin',
    password: 'unit-test-pass',
    version: '14.1.2.0.0',
    ...overrides,
  }
}

test('metric history keeps bounded samples inside the retention window', () => {
  resetMetricHistory()
  const scope = metricHistoryScopeKey(creds())
  const resourceId = serverMetricResourceId('server1')
  const now = 2 * METRIC_HISTORY_RETENTION_MS

  recordMetricSample(scope, { family: 'servers', resourceId, metric: 'heap.percent', value: 10 }, now - METRIC_HISTORY_RETENTION_MS - 1)
  recordMetricSample(scope, { family: 'servers', resourceId, metric: 'heap.percent', value: 20 }, now - 1000)
  recordMetricSample(scope, { family: 'servers', resourceId, metric: 'heap.percent', value: 25 }, now)

  const series = getMetricHistorySeries(scope, 'servers', resourceId, 'heap.percent')
  assert.deepEqual(series.samples.map((sample) => sample.value), [20, 25])
  assert.equal(series.latest, 25)
  assert.equal(series.previous, 20)
  assert.equal(series.delta, 5)
  assert.equal(series.direction, 'up')
})

test('metric history scopes samples by target, version, profile, and credentials', () => {
  resetMetricHistory()
  const resourceId = jdbcMetricResourceId('server1', 'jdbc/AppDS')
  const firstScope = metricHistoryScopeKey(creds())
  const secondScope = metricHistoryScopeKey(creds({ targetUrl: 'http://other.example.com:7001' }))

  recordMetricSample(firstScope, { family: 'jdbc', resourceId, metric: 'connections.waiting', value: 3 }, 1000)
  recordMetricSample(secondScope, { family: 'jdbc', resourceId, metric: 'connections.waiting', value: 9 }, 1000)

  assert.deepEqual(
    getMetricHistorySeries(firstScope, 'jdbc', resourceId, 'connections.waiting').samples.map((sample) => sample.value),
    [3],
  )
  assert.deepEqual(
    getMetricHistorySeries(secondScope, 'jdbc', resourceId, 'connections.waiting').samples.map((sample) => sample.value),
    [9],
  )
})

test('metric history clears the previous scope when active credentials change', () => {
  resetMetricHistory()
  const resourceId = jdbcMetricResourceId('server1', 'jdbc/AppDS')
  const firstScope = metricHistoryScopeKey(creds())
  const secondScope = metricHistoryScopeKey(creds({ targetUrl: 'http://other.example.com:7001' }))

  recordMetricSample(firstScope, { family: 'jdbc', resourceId, metric: 'connections.active', value: 7 }, 1000)
  assert.deepEqual(
    getMetricHistorySeries(firstScope, 'jdbc', resourceId, 'connections.active').samples.map((sample) => sample.value),
    [7],
  )

  assert.equal(resetMetricHistoryScopeOnChange(firstScope, secondScope), secondScope)
  assert.deepEqual(getMetricHistorySeries(firstScope, 'jdbc', resourceId, 'connections.active').samples, [])
})

test('metric history marks stale polling gaps and ignores non-numeric values', () => {
  resetMetricHistory()
  const scope = metricHistoryScopeKey(creds())
  const resourceId = serverMetricResourceId('server1')

  const written = recordMetricSamples(
    scope,
    [
      { family: 'servers', resourceId, metric: 'threads.pending', value: 0 },
      { family: 'servers', resourceId, metric: 'threads.pending', value: Number.NaN },
    ],
    1000,
  )
  recordMetricSample(
    scope,
    { family: 'servers', resourceId, metric: 'threads.pending', value: 4 },
    1000 + METRIC_HISTORY_GAP_MS + 1,
  )

  const series = getMetricHistorySeries(scope, 'servers', resourceId, 'threads.pending')
  assert.equal(written, 1)
  assert.equal(series.samples.length, 2)
  assert.equal(series.samples[0].gapBefore, false)
  assert.equal(series.samples[1].gapBefore, true)
  assert.equal(series.hasGap, true)
})

test('metric history replaces duplicate timestamps instead of double-counting strict mode effects', () => {
  resetMetricHistory()
  const scope = metricHistoryScopeKey(creds())
  const resourceId = serverMetricResourceId('server1')

  assert.equal(recordMetricSample(scope, { family: 'servers', resourceId, metric: 'threads.total', value: 12 }, 1000), true)
  assert.equal(recordMetricSample(scope, { family: 'servers', resourceId, metric: 'threads.total', value: 12 }, 1000), false)
  assert.equal(recordMetricSample(scope, { family: 'servers', resourceId, metric: 'threads.total', value: 13 }, 1000), true)

  const series = getMetricHistorySeries(scope, 'servers', resourceId, 'threads.total')
  assert.deepEqual(series.samples.map((sample) => sample.value), [13])
})

test('metric history never writes browser storage', () => {
  resetMetricHistory()
  const originalLocalStorage = globalThis.localStorage
  const originalSessionStorage = globalThis.sessionStorage
  const localWrites: string[] = []
  const sessionWrites: string[] = []
  const storage = (writes: string[]) => ({
    get length() {
      return writes.length
    },
    clear() {
      writes.push('clear')
    },
    getItem() {
      return null
    },
    key() {
      return null
    },
    removeItem(key: string) {
      writes.push(`remove:${key}`)
    },
    setItem(key: string) {
      writes.push(`set:${key}`)
    },
  })

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage(localWrites),
  })
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: storage(sessionWrites),
  })

  try {
    const scope = metricHistoryScopeKey(creds())
    const resourceId = serverMetricResourceId('server1')

    recordMetricSample(scope, { family: 'servers', resourceId, metric: 'heap.percent', value: 44 }, 1000)

    assert.equal(globalThis.localStorage.length, 0)
    assert.equal(globalThis.sessionStorage.length, 0)
    assert.deepEqual(localWrites, [])
    assert.deepEqual(sessionWrites, [])
  } finally {
    if (originalLocalStorage === undefined) Reflect.deleteProperty(globalThis, 'localStorage')
    else {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: originalLocalStorage,
      })
    }

    if (originalSessionStorage === undefined) Reflect.deleteProperty(globalThis, 'sessionStorage')
    else {
      Object.defineProperty(globalThis, 'sessionStorage', {
        configurable: true,
        value: originalSessionStorage,
      })
    }
  }
})
