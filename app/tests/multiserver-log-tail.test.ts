import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildMultiLogTailSnapshot,
  buildMultiLogTailSources,
  mergeMultiLogTailBuffer,
  multiLogTailRecordsForSource,
  multiLogTailSourceId,
  type LogArchiveRuntime,
  type LogRecordPreviewRow,
} from '../src/api/queries/log-runtime-detail-normalization.ts'

function archive(name: string, label = 'SERVER', kind: LogArchiveRuntime['kind'] = 'server'): LogArchiveRuntime {
  return {
    name,
    kind,
    label,
    description: `${name} archive`,
    latestRecordId: 10,
    earliestAvailableTimestamp: 1000,
    latestAvailableTimestamp: 2000,
    timestampAvailable: true,
  }
}

function record(recordId: number, timestamp: number, message: string): LogRecordPreviewRow {
  return {
    recordId,
    timestamp,
    date: null,
    severity: 'Info',
    severityValue: null,
    subsystem: 'Test',
    machine: null,
    server: 'server',
    thread: null,
    userId: null,
    txId: null,
    contextId: null,
    messageId: `BEA-${recordId}`,
    message,
    supplementalAttributes: null,
    rid: null,
  }
}

test('multi-server log tail selects only bounded requested sources', () => {
  const rows = [
    { serverName: 'AdminServer', archives: [archive('ServerLog'), archive('DomainLog', 'DOMAIN')] },
    { serverName: 'osb_server1', archives: [archive('ServerLog')] },
  ]
  const selected = new Set([
    multiLogTailSourceId('AdminServer', 'ServerLog'),
    multiLogTailSourceId('AdminServer', 'DomainLog'),
    multiLogTailSourceId('osb_server1', 'ServerLog'),
  ])

  const sources = buildMultiLogTailSources(rows, selected, 2)

  assert.deepEqual(sources.map((source) => `${source.serverName}/${source.archive.name}`), [
    'AdminServer/ServerLog',
    'AdminServer/DomainLog',
  ])
})

test('multi-server log tail merges chronologically and dedupes per source', () => {
  const admin = { id: multiLogTailSourceId('AdminServer', 'ServerLog'), serverName: 'AdminServer', archive: archive('ServerLog') }
  const osb = { id: multiLogTailSourceId('osb_server1', 'ServerLog'), serverName: 'osb_server1', archive: archive('ServerLog') }
  const existing = [
    ...multiLogTailRecordsForSource(admin, [record(1, 1000, 'old admin')]),
    ...multiLogTailRecordsForSource(osb, [record(1, 1500, 'osb')]),
  ]
  const incoming = [
    ...multiLogTailRecordsForSource(admin, [record(1, 1000, 'new admin duplicate'), record(2, 2000, 'admin second')]),
  ]

  const merged = mergeMultiLogTailBuffer(existing, incoming, 5, 5)

  assert.deepEqual(merged.map((item) => `${item.sourceServerName}:${item.recordId}:${item.message}`), [
    'AdminServer:1:new admin duplicate',
    'osb_server1:1:osb',
    'AdminServer:2:admin second',
  ])
})

test('multi-server log tail keeps successful records when one source fails', () => {
  const admin = { id: multiLogTailSourceId('AdminServer', 'ServerLog'), serverName: 'AdminServer', archive: archive('ServerLog') }
  const osb = { id: multiLogTailSourceId('osb_server1', 'ServerLog'), serverName: 'osb_server1', archive: archive('ServerLog') }

  const snapshot = buildMultiLogTailSnapshot([
    {
      source: admin,
      outcome: {
        status: 'fulfilled',
        value: {
          status: 'available',
          archiveName: 'ServerLog',
          records: [record(1, 1000, 'admin')],
          nextRecordId: null,
          window: { since: null, until: null, limit: 50 },
        },
      },
    },
    { source: osb, outcome: { status: 'rejected', reason: new Error('timeout') } },
  ])

  assert.equal(snapshot.records.length, 1)
  assert.equal(snapshot.records[0].sourceServerName, 'AdminServer')
  assert.deepEqual(snapshot.partialFailures, [{
    sourceId: osb.id,
    serverName: 'osb_server1',
    archiveName: 'ServerLog',
    message: 'timeout',
    retryable: true,
  }])
})

test('multi-server log tail records retain source archive kind for HTTP access rendering', () => {
  const source = {
    id: multiLogTailSourceId('AdminServer', 'HTTPAccessLog'),
    serverName: 'AdminServer',
    archive: archive('HTTPAccessLog', 'HTTP', 'httpAccess'),
  }

  const records = multiLogTailRecordsForSource(source, [
    record(1, 1000, '192.0.2.15 - - [06/May/2026:12:34:56 +0200] "GET /console HTTP/1.1" 200 1234'),
  ])

  assert.equal(records[0].sourceArchiveName, 'HTTPAccessLog')
  assert.equal(records[0].sourceArchiveLabel, 'HTTP')
  assert.equal(records[0].sourceArchiveKind, 'httpAccess')
})
