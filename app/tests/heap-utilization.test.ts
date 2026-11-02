import assert from 'node:assert/strict'
import test from 'node:test'
import {
  heapSegments,
  heapToneForPercent,
  heapUtilization,
  heapUtilizationLabel,
  normalizeHeapUsage,
} from '../src/api/queries/heap-utilization.ts'

test('normalizes WebLogic heap fields with used-over-max formula', () => {
  const heap = normalizeHeapUsage({
    heapFreeCurrent: 256,
    heapSizeCurrent: 1024,
    heapSizeMax: 2048,
  })

  assert.deepEqual(heap, { current: 768, committed: 1024, max: 2048 })
  assert.equal(heapUtilization(heap), 0.375)
  assert.equal(heapUtilizationLabel(heap), '38%')
  assert.deepEqual(heapSegments(heap), {
    used: 768,
    committed: 1024,
    max: 2048,
    usedPercent: 37.5,
    committedPercent: 50,
    committedUnusedPercent: 12.5,
    emptyPercent: 50,
    tone: 'positive',
  })
})

test('rejects invalid heap inputs and clamps utilization labels', () => {
  assert.equal(normalizeHeapUsage({ heapFreeCurrent: 1, heapSizeCurrent: 2, heapSizeMax: 0 }), null)
  assert.equal(heapUtilization(null), null)
  assert.equal(heapUtilization({ current: -1, max: 100 }), 0)
  assert.equal(heapUtilization({ current: 200, max: 100 }), 1)
  assert.equal(heapUtilizationLabel({ current: 999, max: 1000 }), '99.9%')
  assert.equal(heapSegments(null), null)
  assert.equal(heapSegments({ current: 1, committed: 2, max: 0 }), null)
})

test('heap tone thresholds transition at 70 and 85 percent', () => {
  assert.equal(heapToneForPercent(69), 'positive')
  assert.equal(heapToneForPercent(70), 'warning')
  assert.equal(heapToneForPercent(84.99), 'warning')
  assert.equal(heapToneForPercent(85), 'negative')
  assert.equal(heapToneForPercent(null), 'neutral')
})

test('committed-aware heap segments clamp display values', () => {
  assert.deepEqual(heapSegments({ current: 50, committed: 50, max: 100 }), {
    used: 50,
    committed: 50,
    max: 100,
    usedPercent: 50,
    committedPercent: 50,
    committedUnusedPercent: 0,
    emptyPercent: 50,
    tone: 'positive',
  })

  assert.deepEqual(heapSegments({ current: 50, committed: 80, max: 100 }), {
    used: 50,
    committed: 80,
    max: 100,
    usedPercent: 50,
    committedPercent: 80,
    committedUnusedPercent: 30,
    emptyPercent: 20,
    tone: 'positive',
  })

  assert.deepEqual(heapSegments({ current: 120, committed: 150, max: 100 }), {
    used: 100,
    committed: 100,
    max: 100,
    usedPercent: 100,
    committedPercent: 100,
    committedUnusedPercent: 0,
    emptyPercent: 0,
    tone: 'negative',
  })
})
