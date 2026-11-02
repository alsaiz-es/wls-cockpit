import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTopLevelLogDetailFailures } from '../src/routes/log-detail-failures.ts'

test('top-level log detail failures include runtime and metadata failures only', () => {
  const failures = buildTopLevelLogDetailFailures({
    serverName: 'AdminServer',
    runtimeFailures: [{ serverName: 'AdminServer', signal: 'broadcaster', message: 'HTTP 404 Not Found' }],
    metadataFailures: [{ serverName: 'AdminServer', signal: 'archiveRuntimes', message: 'HTTP 500 Internal Server Error' }],
    metadataError: new Error('metadata unavailable'),
  })

  assert.deepEqual(failures, [
    { serverName: 'AdminServer', signal: 'broadcaster', message: 'HTTP 404 Not Found' },
    { serverName: 'AdminServer', signal: 'archiveRuntimes', message: 'HTTP 500 Internal Server Error' },
    { serverName: 'AdminServer', signal: 'detailMetadata', message: 'metadata unavailable' },
  ])
})

test('top-level log detail failures do not include record-tail failures', () => {
  const failures = buildTopLevelLogDetailFailures({
    serverName: 'AdminServer',
    runtimeFailures: [],
    metadataFailures: [],
    metadataError: null,
  })

  assert.deepEqual(failures, [])
})
