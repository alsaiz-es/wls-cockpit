import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDataSourceUtilization } from '../src/api/queries/data-source-utilization.ts'

test('uses configured max capacity as datasource utilization denominator', () => {
  assert.deepEqual(
    resolveDataSourceUtilization({
      activeConnectionsCurrentCount: 5,
      configuredMaxCapacity: 100,
      currCapacity: 5,
    }),
    {
      utilization: 0.05,
      utilizationCapacity: 100,
      utilizationCapacitySource: 'configuredMax',
    },
  )
})

test('falls back to runtime current capacity when configured max is unavailable', () => {
  assert.deepEqual(
    resolveDataSourceUtilization({
      activeConnectionsCurrentCount: 5,
      configuredMaxCapacity: null,
      currCapacity: 5,
    }),
    {
      utilization: 1,
      utilizationCapacity: 5,
      utilizationCapacitySource: 'runtimeCurrent',
    },
  )
})

test('keeps datasource utilization unavailable when no positive denominator exists', () => {
  assert.deepEqual(
    resolveDataSourceUtilization({
      activeConnectionsCurrentCount: 5,
      configuredMaxCapacity: 0,
      currCapacity: 0,
    }),
    {
      utilization: null,
      utilizationCapacity: null,
      utilizationCapacitySource: null,
    },
  )
})
