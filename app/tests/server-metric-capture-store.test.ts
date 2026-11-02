import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendServerMetricCaptureSamples,
  clearServerMetricCapture,
  getServerMetricCaptureSession,
  getServerMetricCaptureSnapshot,
  resetServerMetricCaptures,
  resetServerMetricCaptureScopeOnChange,
  startServerMetricCapture,
  stopServerMetricCapture,
  updateServerMetricCaptureCadence,
  updateServerMetricCaptureHiddenPolling,
} from '../src/api/queries/server-metric-capture-store.ts'
import type { ServerMetricSampleInput } from '../src/api/queries/server-metrics.ts'

function metric(metricName = 'heap.percent', value: number | null = 42): ServerMetricSampleInput {
  return {
    family: 'jvm',
    resourceId: 'server/osb_server1',
    resourceLabel: 'osb_server1',
    metric: metricName,
    value,
  }
}

test('server metric capture starts, records, stops, and clears a session', () => {
  resetServerMetricCaptures()
  const started = startServerMetricCapture('scope-a', 'osb_server1', 5_000, 1000)

  assert.equal(started?.status, 'active')
  assert.equal(started?.pollingIntervalMs, 5_000)
  assert.equal(started?.pollWhileHidden, false)

  const recorded = appendServerMetricCaptureSamples('scope-a', 'osb_server1', [metric()], 2000)
  assert.equal(recorded?.sampleCount, 1)
  assert.equal(recorded?.pointCount, 1)
  assert.equal(recorded?.samples[0].value, 42)

  const stopped = stopServerMetricCapture('scope-a', 'osb_server1', 3000)
  assert.equal(stopped?.status, 'stopped')
  assert.equal(stopped?.stoppedAt, 3000)

  assert.equal(appendServerMetricCaptureSamples('scope-a', 'osb_server1', [metric('heap.percent', 50)], 4000)?.pointCount, 1)
  clearServerMetricCapture('scope-a', 'osb_server1')
  assert.equal(getServerMetricCaptureSession('scope-a', 'osb_server1'), null)
})

test('server metric capture can opt into hidden-tab polling', () => {
  resetServerMetricCaptures()
  const started = startServerMetricCapture('scope-a', 'osb_server1', 5_000, 1000, {
    pollWhileHidden: true,
  })

  assert.equal(started?.pollWhileHidden, true)

  const updated = updateServerMetricCaptureHiddenPolling('scope-a', 'osb_server1', false)
  assert.equal(updated?.pollWhileHidden, false)
})

test('server metric capture supports cadence updates and gap marking', () => {
  resetServerMetricCaptures()
  startServerMetricCapture('scope-a', 'osb_server1', 5_000, 1000)
  updateServerMetricCaptureCadence('scope-a', 'osb_server1', 10_000)
  appendServerMetricCaptureSamples('scope-a', 'osb_server1', [metric('heap.percent', 10)], 2000)
  const session = appendServerMetricCaptureSamples('scope-a', 'osb_server1', [metric('heap.percent', 20)], 20_000)

  assert.equal(session?.pollingIntervalMs, 10_000)
  assert.equal(session?.sampleCount, 2)
  assert.equal(session?.gapCount, 1)
  assert.equal(session?.samples.at(-1)?.gapBefore, true)
})

test('server metric capture retention caps ticks and points', () => {
  resetServerMetricCaptures()
  startServerMetricCapture('scope-a', 'osb_server1', 5_000, 1000)

  appendServerMetricCaptureSamples('scope-a', 'osb_server1', [metric('heap.percent', 1)], 1000, {
    maxTicks: 2,
    retentionMs: 1_000_000,
  })
  appendServerMetricCaptureSamples('scope-a', 'osb_server1', [metric('heap.percent', 2)], 2000, {
    maxTicks: 2,
    retentionMs: 1_000_000,
  })
  const session = appendServerMetricCaptureSamples('scope-a', 'osb_server1', [metric('heap.percent', 3)], 3000, {
    maxTicks: 2,
    retentionMs: 1_000_000,
  })

  assert.equal(session?.sampleCount, 2)
  assert.deepEqual(session?.ticks.map((tick) => tick.timestamp), [2000, 3000])
  assert.deepEqual(session?.samples.map((sample) => sample.value), [2, 3])
})

test('server metric capture records ticks even when values are unavailable', () => {
  resetServerMetricCaptures()
  startServerMetricCapture('scope-a', 'osb_server1', 5_000, 1000)
  const session = appendServerMetricCaptureSamples('scope-a', 'osb_server1', [metric('cpu.process', null)], 2000)

  assert.equal(session?.sampleCount, 1)
  assert.equal(session?.pointCount, 0)
})

test('server metric capture isolates servers and clears on scope changes', () => {
  resetServerMetricCaptures()
  startServerMetricCapture('scope-a', 'osb_server1', 5_000, 1000)
  startServerMetricCapture('scope-a', 'AdminServer', 30_000, 1000)
  appendServerMetricCaptureSamples('scope-a', 'osb_server1', [metric()], 2000)

  assert.equal(getServerMetricCaptureSession('scope-a', 'osb_server1')?.pointCount, 1)
  assert.equal(getServerMetricCaptureSession('scope-a', 'AdminServer')?.pointCount, 0)

  const nextScope = resetServerMetricCaptureScopeOnChange('scope-a', 'scope-b')
  assert.equal(nextScope, 'scope-b')
  assert.equal(getServerMetricCaptureSnapshot().scopeKey, 'scope-b')
  assert.deepEqual(Object.keys(getServerMetricCaptureSnapshot().sessions), [])
})

test('server metric capture stores omitted resource counts and never writes browser storage', () => {
  const localStorage = { length: 0 }
  const sessionStorage = { length: 0 }
  Object.defineProperty(globalThis, 'localStorage', { value: localStorage, configurable: true })
  Object.defineProperty(globalThis, 'sessionStorage', { value: sessionStorage, configurable: true })

  resetServerMetricCaptures()
  startServerMetricCapture('scope-a', 'osb_server1', 5_000, 1000)
  const session = appendServerMetricCaptureSamples('scope-a', 'osb_server1', [metric()], 2000, {
    omitted: { jdbc: 3, jms: 4 },
  })

  assert.deepEqual(session?.omitted, { jdbc: 3, jms: 4 })
  assert.equal(globalThis.localStorage.length, 0)
  assert.equal(globalThis.sessionStorage.length, 0)
})
