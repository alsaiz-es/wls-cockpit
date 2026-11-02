import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canOfferHeapDumpCapture,
  normalizeThreadDumpPayload,
  serverHeapDumpSupport,
  shouldShowHeapDumpUnsupported,
  threadDumpFilename,
} from '../src/api/queries/server-diagnostics.ts'

test('normalizes thread dump payload metadata', () => {
  const dump = normalizeThreadDumpPayload(
    { threadStackDump: '"main" RUNNABLE\n\tat example.Main.run(Main.java:1)\n"worker" WAITING' },
    'AdminServer',
    Date.UTC(2026, 3, 30, 12, 0, 0),
  )

  assert.equal(dump.serverName, 'AdminServer')
  assert.equal(dump.capturedAt, Date.UTC(2026, 3, 30, 12, 0, 0))
  assert.equal(dump.lineCount, 3)
  assert.equal(dump.bytes, Buffer.byteLength(dump.text))
})

test('rejects missing or empty thread dump payloads', () => {
  assert.throws(
    () => normalizeThreadDumpPayload({ threadStackDump: '   ' }, 'AdminServer'),
    /empty threadStackDump payload/,
  )
  assert.throws(
    () => normalizeThreadDumpPayload({}, 'AdminServer'),
    /empty threadStackDump payload/,
  )
})

test('builds filesystem-safe thread dump filenames', () => {
  assert.equal(
    threadDumpFilename('osb/server:1', Date.UTC(2026, 3, 30, 12, 0, 0, 123)),
    'wls-thread-dump-osb_server_1-2026-04-30T12-00-00-123Z.txt',
  )
})

test('reports heap dump capture as unsupported with bounded evidence', () => {
  const support = serverHeapDumpSupport('14.1.2.0.0')
  const serialized = JSON.stringify(support)

  assert.equal(support.supported, false)
  assert.match(support.reason, /14\.1\.2\.0\.0/)
  assert.ok(support.evidence.length >= 2)
  assert.match(serialized, /JVMRuntime/)
  assert.doesNotMatch(serialized, /\bpassword\b/i)
  assert.doesNotMatch(serialized, /\bBasic\s+[A-Za-z0-9+/=._-]+/i)
  assert.doesNotMatch(serialized, /192\.168\./)
})

test('gates heap dump capture on running state, normal mode, and verified support', () => {
  const unsupported = serverHeapDumpSupport('12.2.1.4.0')

  assert.equal(
    canOfferHeapDumpCapture({
      lifecycleState: 'RUNNING',
      readOnlyDemoMode: false,
      support: unsupported,
    }),
    false,
  )
  assert.equal(
    canOfferHeapDumpCapture({
      lifecycleState: 'SHUTDOWN',
      readOnlyDemoMode: false,
      support: unsupported,
    }),
    false,
  )
  assert.equal(
    canOfferHeapDumpCapture({
      lifecycleState: 'RUNNING',
      readOnlyDemoMode: true,
      support: unsupported,
    }),
    false,
  )
})

test('shows heap dump unsupported state only for running servers in normal mode', () => {
  const unsupported = serverHeapDumpSupport('14.1.2.0.0')

  assert.equal(
    shouldShowHeapDumpUnsupported({
      lifecycleState: 'RUNNING',
      readOnlyDemoMode: false,
      support: unsupported,
    }),
    true,
  )
  assert.equal(
    shouldShowHeapDumpUnsupported({
      lifecycleState: 'ADMIN',
      readOnlyDemoMode: false,
      support: unsupported,
    }),
    false,
  )
  assert.equal(
    shouldShowHeapDumpUnsupported({
      lifecycleState: 'RUNNING',
      readOnlyDemoMode: true,
      support: unsupported,
    }),
    false,
  )
})
