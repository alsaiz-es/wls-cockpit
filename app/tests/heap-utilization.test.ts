import assert from 'node:assert/strict'
import test from 'node:test'
import {
  heapSegments,
  heapThresholdMarks,
  heapToneForPercent,
  heapUtilization,
  heapUtilizationLabel,
  normalizeHeapUsage,
} from '../src/api/queries/heap-utilization.ts'
import { resolveAlertRules, validateAlertRulesConfig } from '../src/api/alert-rules.ts'

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

test('heap bars take their colour from the alert level, never from the reading alone', () => {
  assert.equal(heapToneForPercent(99), 'positive')
  assert.equal(heapToneForPercent(99, 'warning'), 'warning')
  assert.equal(heapToneForPercent(60, 'critical'), 'negative')
  assert.equal(heapToneForPercent(null, 'warning'), 'neutral')
  assert.deepEqual(heapThresholdMarks(), [90])

  const { config } = validateAlertRulesConfig({ rules: { 'heap.percent': { warning: 75, critical: 95 } } })
  assert.deepEqual(heapThresholdMarks(resolveAlertRules(config, null)), [75, 95])
  assert.deepEqual(heapThresholdMarks(resolveAlertRules(validateAlertRulesConfig({ rules: { 'heap.percent': { enabled: false } } }).config, null)), [])
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
  })

  assert.deepEqual(heapSegments({ current: 50, committed: 80, max: 100 }), {
    used: 50,
    committed: 80,
    max: 100,
    usedPercent: 50,
    committedPercent: 80,
    committedUnusedPercent: 30,
    emptyPercent: 20,
  })

  assert.deepEqual(heapSegments({ current: 120, committed: 150, max: 100 }), {
    used: 100,
    committed: 100,
    max: 100,
    usedPercent: 100,
    committedPercent: 100,
    committedUnusedPercent: 0,
    emptyPercent: 0,
  })
})
