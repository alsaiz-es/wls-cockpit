import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildServerMetricChartModel,
  relativeMetricTimeLabel,
  type ServerMetricChartPoint,
} from '../src/components/server-metric-chart-model.ts'

function point(timestamp: number, value: number, gapBefore = false): ServerMetricChartPoint {
  return { timestamp, value, gapBefore }
}

test('server metric chart model returns empty state for unavailable series', () => {
  const model = buildServerMetricChartModel([])

  assert.equal(model.state, 'empty')
  assert.deepEqual(model.segments, [])
  assert.equal(model.latest, null)
})

test('server metric chart model segments paths at polling gaps', () => {
  const model = buildServerMetricChartModel([
    point(1000, 1),
    point(2000, 2),
    point(20_000, 3, true),
    point(21_000, 4),
  ])

  assert.equal(model.state, 'series')
  assert.equal(model.hasGap, true)
  assert.equal(model.segments.length, 2)
  assert.deepEqual(model.segments.map((segment) => segment.indexes), [[0, 1], [2, 3]])
  assert.match(model.segments[0].path, /^M /)
  assert.match(model.segments[1].path, /^M /)
})

test('server metric chart model reports latest and delta vs previous sample', () => {
  const model = buildServerMetricChartModel([point(1000, 10), point(2000, 13)])

  assert.equal(model.latest, 13)
  assert.equal(model.previous, 10)
  assert.equal(model.delta, 3)
  assert.equal(relativeMetricTimeLabel(1000, 2000), '-1s')
})
