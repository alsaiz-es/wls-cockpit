import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LOG_TAIL_INITIAL_RECORDS,
  LOG_TAIL_MAX_PAGES,
  LOG_TAIL_PAGE_SIZE,
  logSeverityQuery,
  readLogTail,
  type WldfRecordSearch,
  type WldfRecordSearchBody,
} from '../src/api/queries/log-tail.ts'
import type { LogRecordPreviewRow } from '../src/api/queries/log-runtime-detail-normalization.ts'
import { readLogsTailSelection, writeLogsTailSelection } from '../src/routes/logs-tail-selection.ts'
import { logRecordSeverityGroup, logRecordSeverityTone } from '../src/routes/log-record-severity.ts'

function row(recordId: number, severityValue = 64): LogRecordPreviewRow {
  return {
    recordId,
    timestamp: 1_700_000_000_000 + recordId,
    date: null,
    severity: severityValue <= 8 ? 'Error' : severityValue <= 16 ? 'Warning' : 'Info',
    severityValue,
    subsystem: 'Test',
    machine: null,
    server: 'server1',
    thread: null,
    userId: null,
    txId: null,
    contextId: null,
    messageId: null,
    message: `record ${recordId}`,
    supplementalAttributes: null,
    rid: null,
  }
}

// A WLDF archive as the search action behaves on 12.2.1.4: ascending from `fromId`,
// `limit` caps the page, `query` filters on SEVERITY_VALUE.
function archive(latest: number, severityOf: (id: number) => number = () => 64) {
  const calls: WldfRecordSearchBody[] = []
  const search: WldfRecordSearch = async (body) => {
    calls.push(body)
    const max = body.query ? Number(/SEVERITY_VALUE <= (\d+)/.exec(body.query)?.[1]) : Infinity
    const records: LogRecordPreviewRow[] = []
    let id = Math.max(1, body.fromId ?? 1)
    for (; id <= latest && records.length < body.limit; id += 1) {
      if (severityOf(id) <= max) records.push(row(id, severityOf(id)))
    }
    return { records, nextRecordId: id <= latest ? id : null }
  }
  return { search, calls, latestRecordId: async () => latest }
}

test('a new tail starts at the newest records, not at the oldest of a time window', async () => {
  const lab = archive(346_519)
  const tail = await readLogTail({ search: lab.search, cursor: null, latestRecordId: lab.latestRecordId })

  assert.equal(tail.records.length, LOG_TAIL_INITIAL_RECORDS)
  assert.equal(tail.records.at(-1)?.recordId, 346_519)
  assert.equal(tail.records[0]?.recordId, 346_519 - LOG_TAIL_INITIAL_RECORDS + 1)
  assert.equal(lab.calls.length, 1)
  assert.equal(lab.calls[0]?.since, undefined)
})

test('polling reads only what follows the cursor, in one request when there is little', async () => {
  const lab = archive(1_020)
  const tail = await readLogTail({
    search: lab.search,
    cursor: { latestRecordId: 1_000, latestTimestamp: null },
    latestRecordId: async () => assert.fail('steady polls must not look up latestRecordId'),
  })

  assert.deepEqual(tail.records.map((record) => record.recordId), Array.from({ length: 20 }, (_, i) => 1_001 + i))
  assert.equal(tail.skippedAhead, false)
  assert.deepEqual(lab.calls, [{ fromId: 1_001, limit: LOG_TAIL_PAGE_SIZE }])
})

test('a burst within the page budget is read completely', async () => {
  const lab = archive(1_000 + LOG_TAIL_PAGE_SIZE * 2 + 10)
  const tail = await readLogTail({
    search: lab.search,
    cursor: { latestRecordId: 1_000, latestTimestamp: null },
    latestRecordId: lab.latestRecordId,
  })

  assert.equal(tail.records.length, LOG_TAIL_PAGE_SIZE * 2 + 10)
  assert.equal(tail.skippedAhead, false)
})

test('a burst larger than the page budget jumps to the newest records instead of lagging', async () => {
  const latest = 1_000 + LOG_TAIL_PAGE_SIZE * (LOG_TAIL_MAX_PAGES + 3)
  const lab = archive(latest)
  const tail = await readLogTail({
    search: lab.search,
    cursor: { latestRecordId: 1_000, latestTimestamp: null },
    latestRecordId: lab.latestRecordId,
  })

  assert.equal(tail.skippedAhead, true)
  assert.equal(tail.records.at(-1)?.recordId, latest)
  assert.equal(tail.records.length, LOG_TAIL_INITIAL_RECORDS)
})

test('a severity filter is applied by WebLogic and widens the id span until it has enough matches', async () => {
  // One warning every 300 records: 2,000 ids hold too few, 20,000 hold enough.
  const lab = archive(100_000, (id) => (id % 300 === 0 ? 16 : 64))
  const tail = await readLogTail({
    search: lab.search,
    cursor: null,
    latestRecordId: lab.latestRecordId,
    query: logSeverityQuery('warning'),
  })

  assert.equal(tail.records.length, LOG_TAIL_INITIAL_RECORDS)
  assert.ok(tail.records.every((record) => record.severityValue === 16))
  assert.equal(tail.records.at(-1)?.recordId, 99_900)
  assert.deepEqual(lab.calls.map((call) => call.fromId), [98_000, 80_000])
  assert.ok(lab.calls.every((call) => call.query === 'SEVERITY_VALUE <= 16'))
})

test('severity floors map to WebLogic severity values', () => {
  assert.equal(logSeverityQuery('all'), undefined)
  assert.equal(logSeverityQuery('notice'), 'SEVERITY_VALUE <= 32')
  assert.equal(logSeverityQuery('error'), 'SEVERITY_VALUE <= 8')
})

test('Notice is informational, not an error', () => {
  assert.equal(logRecordSeverityGroup('Notice'), 'info')
  assert.equal(logRecordSeverityTone('Notice'), 'neutral')
  assert.equal(logRecordSeverityTone('Error'), 'negative')
  assert.equal(logRecordSeverityTone('Alert'), 'negative')
  assert.equal(logRecordSeverityGroup('Warning'), 'warning')
  assert.equal(logRecordSeverityTone('Info'), 'positive')
})

class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}

test('the global tail selection is kept per connection profile', () => {
  const storage = new MemoryStorage()
  writeLogsTailSelection('profile-a', { sourceIds: ['AdminServer|ServerLog'], severityFloor: 'warning' }, storage)

  assert.deepEqual(readLogsTailSelection('profile-a', storage), {
    sourceIds: ['AdminServer|ServerLog'],
    severityFloor: 'warning',
  })
  assert.deepEqual(readLogsTailSelection('profile-b', storage), { sourceIds: [], severityFloor: 'all' })

  storage.setItem('wls-cockpit:logs-tail:profile-c', '{"sourceIds":[1,"x"],"severityFloor":"bogus"}')
  assert.deepEqual(readLogsTailSelection('profile-c', storage), { sourceIds: ['x'], severityFloor: 'all' })
})

test('a failed tail source is not polled again until retried', async () => {
  const { mergeTailFailures, pollableTailSources } = await import('../src/api/queries/log-tail.ts')
  const source = (id: string) => ({
    id,
    serverName: 'osb_server1',
    archive: {
      name: id,
      kind: 'server' as const,
      label: 'SERVER',
      description: '',
      latestRecordId: null,
      earliestAvailableTimestamp: null,
      latestAvailableTimestamp: null,
      timestampAvailable: null,
    },
  })
  const failure = (sourceId: string, message: string) => ({
    sourceId,
    serverName: 'osb_server1',
    archiveName: sourceId,
    message,
    retryable: true,
  })

  const failures = mergeTailFailures([failure('HTTPAccessLog', 'HTTP 500')], [failure('HTTPAccessLog', 'HTTP 500 again')])
  assert.equal(failures.length, 1)
  assert.equal(failures[0]?.message, 'HTTP 500 again')
  assert.deepEqual(
    pollableTailSources([source('ServerLog'), source('HTTPAccessLog')], failures).map((s) => s.id),
    ['ServerLog'],
  )
})

test('the severity floor can also be applied in the browser for releases without query support', async () => {
  const { filterBySeverityFloor } = await import('../src/api/queries/log-tail.ts')
  const records = [row(1, 64), row(2, 16), row(3, 8), { ...row(4), severityValue: null }]
  assert.deepEqual(filterBySeverityFloor(records, 'warning').map((record) => record.recordId), [2, 3])
  assert.equal(filterBySeverityFloor(records, 'all').length, 4)
})

test('an archive that reports latestRecordId 0 is probed for its last record', async () => {
  // HTTPAccessLog on 14.1.2: records up to 858 while the runtime reports latestRecordId = 0.
  for (const latest of [858, 123_457, 3]) {
    const lab = archive(latest)
    const tail = await readLogTail({ search: lab.search, cursor: null, latestRecordId: async () => 0 })
    assert.equal(tail.records.at(-1)?.recordId, latest)
    assert.equal(tail.records.length, Math.min(LOG_TAIL_INITIAL_RECORDS, latest))
    assert.ok(lab.calls.length < 70, `${lab.calls.length} requests`)
  }
  const empty = archive(0)
  assert.deepEqual(await readLogTail({ search: empty.search, cursor: null, latestRecordId: async () => 0 }), {
    records: [],
    skippedAhead: false,
  })
})
