import assert from 'node:assert/strict'
import test from 'node:test'
import {
  serverMetricCaptureCsv,
  serverMetricCaptureFilename,
  serverMetricCaptureJson,
} from '../src/api/queries/server-metric-capture-export.ts'
import type { ServerMetricCaptureSession } from '../src/api/queries/server-metric-capture-store.ts'

function session(): ServerMetricCaptureSession {
  return {
    id: 'session-1',
    scopeKey: 'scope-a',
    serverName: 'osb_server1',
    status: 'stopped',
    pollingIntervalMs: 5_000,
    pollWhileHidden: true,
    startedAt: Date.parse('2026-05-04T10:00:00.000Z'),
    stoppedAt: Date.parse('2026-05-04T10:05:00.000Z'),
    ticks: [],
    samples: [{
      timestamp: Date.parse('2026-05-04T10:00:05.000Z'),
      family: 'jvm',
      resourceId: 'server/osb_server1',
      resourceLabel: 'osb_server1',
      metric: 'cpu.process',
      value: 12.5,
      gapBefore: false,
    }],
    resources: {},
    sampleCount: 1,
    pointCount: 1,
    gapCount: 0,
    omitted: { jdbc: 2, jms: 3 },
  }
}

const creds = {
  targetUrl: 'http://admin:unit-test-pass@wls-admin.example.com:7001/management',
  version: '12.2.1.4.0',
}

test('server metric capture CSV includes metadata and rows with sanitized target', () => {
  const csv = serverMetricCaptureCsv(session(), creds)

  assert.match(csv, /^# target=wls-admin.example.com:7001/m)
  assert.match(csv, /^# version=12\.2\.1\.4\.0/m)
  assert.match(csv, /^# pollWhileHidden=true/m)
  assert.match(csv, /^# omittedJdbcCount=2/m)
  assert.match(csv, /timestampIso,timestampMs,server,family,resourceId,resourceLabel,metric,value,gapBefore/)
  assert.match(csv, /2026-05-04T10:00:05.000Z,\d+,osb_server1,jvm,server\/osb_server1,osb_server1,cpu.process,12.5,false/)
  assert.doesNotMatch(csv, /unit-test-pass|admin@/)
})

test('server metric capture JSON wraps metadata and samples', () => {
  const json = serverMetricCaptureJson(session(), creds)

  assert.equal(json.metadata.target, 'wls-admin.example.com:7001')
  assert.equal(json.metadata.server, 'osb_server1')
  assert.equal(json.metadata.pollWhileHidden, true)
  assert.equal(json.samples[0]?.metric, 'cpu.process')
  assert.equal(json.samples[0]?.value, 12.5)
})

test('server metric capture raw target opt-in still strips credentials', () => {
  const json = serverMetricCaptureJson(session(), creds, true)

  assert.equal(json.metadata.target, 'http://wls-admin.example.com:7001/management')
  assert.doesNotMatch(JSON.stringify(json), /unit-test-pass|admin@/)
})

test('server metric capture filenames are stable and sanitized', () => {
  assert.equal(
    serverMetricCaptureFilename({ serverName: 'osb/server 1', startedAt: Date.parse('2026-05-04T10:00:00.000Z') }, 'csv'),
    'server-metrics-osb-server-1-2026-05-04T10-00-00-000Z.csv',
  )
})
