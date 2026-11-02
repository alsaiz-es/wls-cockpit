import assert from 'node:assert/strict'
import test from 'node:test'
import {
  jvmHeapQueryParams,
  serverLifecycleQueryParams,
  serverRuntimeBaseQueryParams,
  threadPoolQueryParams,
} from '../src/api/queries/server-runtime-query-params.ts'
import { normalizeJvmRuntime } from '../src/api/queries/server-runtimes.ts'

test('server lifecycle heartbeat polling only requests name and state', () => {
  assert.deepEqual(serverLifecycleQueryParams(), { fields: 'name,state', links: 'none' })
})

test('server lifecycle heartbeat stays narrower than runtime base polling', () => {
  const heartbeatParams = serverLifecycleQueryParams()
  const runtimeParams = serverRuntimeBaseQueryParams()

  assert.doesNotMatch(heartbeatParams.fields, /healthState|listenAddress|listenPort|defaultURL/)
  assert.notEqual(heartbeatParams.fields, runtimeParams.fields)
  assert.equal(heartbeatParams.links, 'none')
})

test('server runtime base polling excludes thread dump payloads', () => {
  const params = serverRuntimeBaseQueryParams()

  assert.doesNotMatch(params.fields, /\bJVMRuntime\b/)
  assert.doesNotMatch(params.fields, /\bthreadPoolRuntime\b/)
  assert.doesNotMatch(params.fields, /threadStackDump/)
  assert.equal('excludeFields' in params, false)
  assert.equal(params.links, 'none')
})

test('per-server JVM polling requests heap and runtime metadata without thread dumps', () => {
  const params = jvmHeapQueryParams()

  assert.equal(
    params.fields,
    'heapFreeCurrent,heapSizeCurrent,heapSizeMax,uptime,javaVersion,javaVendor,javaVMVendor,OSName,OSVersion,processCpuLoad',
  )
  assert.match(params.fields, /\buptime\b/)
  assert.match(params.fields, /\bjavaVersion\b/)
  assert.match(params.fields, /\bjavaVendor\b/)
  assert.match(params.fields, /\bjavaVMVendor\b/)
  assert.match(params.fields, /\bOSName\b/)
  assert.match(params.fields, /\bOSVersion\b/)
  assert.match(params.fields, /\bprocessCpuLoad\b/)
  assert.doesNotMatch(params.fields, /threadStackDump/)
  assert.equal(params.links, 'none')
})

test('normalizes optional JVM process CPU load defensively', () => {
  assert.equal(normalizeJvmRuntime({ processCpuLoad: 0.25 })?.processCpuLoad, 0.25)
  assert.equal(normalizeJvmRuntime({ processCpuLoad: 2 })?.processCpuLoad, 1)
  assert.equal(normalizeJvmRuntime({ processCpuLoad: -1 })?.processCpuLoad, 0)
  assert.equal(normalizeJvmRuntime({ processCpuLoad: '0.25' })?.processCpuLoad, null)
  assert.equal(normalizeJvmRuntime({})?.processCpuLoad, null)
  assert.equal(normalizeJvmRuntime(null), null)
})

test('per-server thread pool polling only requests thread counters', () => {
  const params = threadPoolQueryParams()

  assert.equal(
    params.fields,
    'executeThreadTotalCount,executeThreadIdleCount,standbyThreadCount,pendingUserRequestCount,queueLength,hoggingThreadCount,stuckThreadCount',
  )
  assert.match(params.fields, /\bpendingUserRequestCount\b/)
  assert.match(params.fields, /\bhoggingThreadCount\b/)
  assert.match(params.fields, /\bqueueLength\b/)
  assert.equal(params.links, 'none')
})
