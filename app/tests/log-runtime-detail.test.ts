import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyLogArchiveSummaries,
  buildLogDetailMetadataSnapshot,
  buildLogRecordSearchWindow,
  buildLogRecordTailSearchWindow,
  buildSelectedLogRuntimeSnapshot,
  classifyLogArchiveName,
  isHttpAccessLogArchiveName,
  latestLogRecordTailCursor,
  logTailArchiveUrlValue,
  logArchiveRuntimeQueryParams,
  logBroadcasterQueryParams,
  logDataAccessDetailQueryParams,
  logDataAccessSummaryQueryParams,
  logRecordSearchPayload,
  mergeLogRecordTailBuffer,
  logServerRuntimeQueryParams,
  logTailSelectionKey,
  normalizeLogArchiveRuntimeCounters,
  normalizeLogDataAccessRuntimeDetail,
  normalizeLogRecordPreviewRow,
  normalizeLogRecordPreviewSnapshot,
  parseHttpAccessLogMessage,
  parseHttpAccessLogRecord,
  resolveLogTailArchiveSelection,
  serverLogRuntimeQueryParams,
  selectDefaultLogTailArchive,
  wldfLogRecordSearchRequest,
} from '../src/api/queries/log-runtime-detail-normalization.ts'
import { WlsRestError } from '../src/api/wls-errors.ts'

test('keeps log list polling payload lightweight', () => {
  assert.deepEqual(logServerRuntimeQueryParams(), { fields: 'name,state', links: 'none' })
  assert.deepEqual(logBroadcasterQueryParams(), { fields: 'messagesLogged', links: 'none' })
  assert.deepEqual(serverLogRuntimeQueryParams(), { fields: 'logFileStreamOpened', links: 'none' })
  assert.deepEqual(logDataAccessSummaryQueryParams(), {
    fields: 'name,latestRecordId,earliestAvailableTimestamp,latestAvailableTimestamp,timestampAvailable',
    links: 'none',
  })
})

test('requests log data-access detail metadata with an explicit allow-list', () => {
  assert.deepEqual(logDataAccessDetailQueryParams(), {
    fields:
      'name,type,columnIndexMap,columnInfoMap,columnTypeMap,columns,earliestAvailableTimestamp,latestAvailableTimestamp,latestRecordId,timestampAvailable,dataArchiveParameters',
    links: 'none',
  })
})

test('requests log archive runtime counters with an explicit allow-list', () => {
  assert.deepEqual(logArchiveRuntimeQueryParams(), {
    fields:
      'name,type,recordRetrievalTime,recordSeekCount,recordSeekTime,retrievedRecordCount,dataRetirementCycles,dataRetirementTotalTime,lastDataRetirementStartTime,lastDataRetirementTime,retiredRecordCount,deletionCount,deletionTime,insertionCount,insertionTime,indexPageCount,recordCount,incrementalIndexCycleCount,incrementalIndexTime,indexCycleCount,indexTime,rotatedFilesCount',
    links: 'none',
  })
})

test('selects ServerLog as the default live tail archive when present', () => {
  const archives = [
    {
      name: 'HTTPAccessLog',
      latestRecordId: 10,
      earliestAvailableTimestamp: 1000,
      latestAvailableTimestamp: 2000,
      timestampAvailable: true,
    },
    {
      name: 'ServerLog',
      latestRecordId: null,
      earliestAvailableTimestamp: null,
      latestAvailableTimestamp: null,
      timestampAvailable: false,
    },
  ]

  assert.equal(selectDefaultLogTailArchive(archives)?.name, 'ServerLog')
})

test('selects the first anchored WLDF archive when ServerLog is absent', () => {
  const archives = [
    {
      name: 'HarvestedDataArchive',
      latestRecordId: null,
      earliestAvailableTimestamp: null,
      latestAvailableTimestamp: null,
      timestampAvailable: null,
    },
    {
      name: 'JMSMessageLog/AgentTestJMSServer',
      latestRecordId: 7,
      earliestAvailableTimestamp: null,
      latestAvailableTimestamp: null,
      timestampAvailable: false,
    },
  ]

  assert.equal(selectDefaultLogTailArchive(archives)?.name, 'JMSMessageLog/AgentTestJMSServer')
})

test('classifies WLDF archive names for operator-facing labels', () => {
  assert.deepEqual(classifyLogArchiveName('ServerLog'), {
    kind: 'server',
    label: 'SERVER',
    description: 'WebLogic server log archive.',
  })
  assert.equal(classifyLogArchiveName('EventsDataArchive').kind, 'diagnosticEvent')
  assert.equal(classifyLogArchiveName('HTTPAccessLog').kind, 'httpAccess')
  assert.equal(classifyLogArchiveName('HTTPAccessLog/AdminServer').kind, 'httpAccess')
  assert.equal(classifyLogArchiveName('CUSTOM/HTTP_Access_Log/AdminServer').kind, 'httpAccess')
  assert.equal(classifyLogArchiveName('CUSTOM/com.bea.wli.monitoring.pipeline.alert').label, 'DIAG/EVENT')
  assert.equal(classifyLogArchiveName('JMSMessageLog/wlsbJMSServer_auto_2').label, 'JMS')
  assert.equal(classifyLogArchiveName('CUSTOM/other').kind, 'custom')
})

test('detects HTTP access log archive name variants for tail layout fallback', () => {
  assert.equal(isHttpAccessLogArchiveName('HTTPAccessLog'), true)
  assert.equal(isHttpAccessLogArchiveName('HTTPAccessLog/AdminServer'), true)
  assert.equal(isHttpAccessLogArchiveName('CUSTOM/http_access_log/AdminServer'), true)
  assert.equal(isHttpAccessLogArchiveName('ServerLog'), false)
  assert.equal(isHttpAccessLogArchiveName(null), false)
})

test('prefers anchored diagnostic event archive when ServerLog is absent', () => {
  const archives = [
    normalizeLogDataAccessRuntimeDetail({
      name: 'HarvestedDataArchive',
      latestRecordId: 20,
      timestampAvailable: true,
    }),
    normalizeLogDataAccessRuntimeDetail({
      name: 'EventsDataArchive',
      latestRecordId: 7,
      timestampAvailable: true,
    }),
  ].filter((archive): archive is NonNullable<typeof archive> => archive !== null)

  assert.equal(selectDefaultLogTailArchive(archives)?.name, 'EventsDataArchive')
  assert.equal(selectDefaultLogTailArchive(archives)?.label, 'DIAG/EVENT')
})

test('resolves live tail selection only from reported WLDF archives', () => {
  const archives = [
    {
      name: 'EventsDataArchive',
      latestRecordId: 1,
      earliestAvailableTimestamp: 1000,
      latestAvailableTimestamp: 2000,
      timestampAvailable: true,
    },
  ]

  assert.equal(resolveLogTailArchiveSelection(archives, 'osb_server1-diagnostic.log')?.name, 'EventsDataArchive')
  assert.deepEqual(resolveLogTailArchiveSelection(archives, 'EventsDataArchive'), {
    name: 'EventsDataArchive',
    latestRecordId: 1,
    earliestAvailableTimestamp: 1000,
    latestAvailableTimestamp: 2000,
    timestampAvailable: true,
  })
  assert.equal(resolveLogTailArchiveSelection([], 'osb_server1-diagnostic.log'), null)
})

test('encodes non-default live tail archive URL values only for reported archive selections', () => {
  const archives = [
    {
      name: 'ServerLog',
      latestRecordId: 2,
      earliestAvailableTimestamp: null,
      latestAvailableTimestamp: 2000,
      timestampAvailable: true,
    },
    {
      name: 'JMSMessageLog/AgentTestJMSServer',
      latestRecordId: 1,
      earliestAvailableTimestamp: null,
      latestAvailableTimestamp: null,
      timestampAvailable: true,
    },
  ]
  const defaultArchive = resolveLogTailArchiveSelection(archives, null)
  const selectedArchive = resolveLogTailArchiveSelection(archives, 'JMSMessageLog/AgentTestJMSServer')

  assert.equal(logTailArchiveUrlValue(defaultArchive, defaultArchive), null)
  assert.equal(logTailArchiveUrlValue(selectedArchive, defaultArchive), 'JMSMessageLog/AgentTestJMSServer')
  assert.equal(resolveLogTailArchiveSelection(archives, 'does-not-exist')?.name, 'ServerLog')
})

test('keys live tail reset by server and archive selection only', () => {
  const archive = {
    name: 'HTTPAccessLog',
    latestRecordId: 10,
    earliestAvailableTimestamp: 1000,
    latestAvailableTimestamp: 2000,
    timestampAvailable: true,
  }

  assert.equal(logTailSelectionKey(' osb_server1 ', archive), 'osb_server1:HTTPAccessLog')
  assert.equal(
    logTailSelectionKey('osb_server1', { ...archive, latestAvailableTimestamp: 3000 }),
    'osb_server1:HTTPAccessLog',
  )
  assert.notEqual(
    logTailSelectionKey('osb_server1', archive),
    logTailSelectionKey('osb_server1', { ...archive, name: 'ServerLog' }),
  )
})

test('normalizes log data-access detail metadata defensively', () => {
  assert.deepEqual(
    normalizeLogDataAccessRuntimeDetail({
      name: ' ServerLog ',
      type: 'WLDFDataAccessRuntime',
      latestRecordId: 42,
      earliestAvailableTimestamp: 1000,
      latestAvailableTimestamp: 2000,
      timestampAvailable: true,
      columns: [{ name: 'TIME' }, { name: 'MESSAGE' }],
      columnIndexMap: { TIME: 0, MESSAGE: 1 },
      columnInfoMap: { TIME: {}, MESSAGE: {} },
      columnTypeMap: { TIME: 'long' },
      dataArchiveParameters: { storeDir: 'servers/AdminServer/data/store/diagnostics' },
    }),
    {
      name: 'ServerLog',
      kind: 'server',
      label: 'SERVER',
      description: 'WebLogic server log archive.',
      type: 'WLDFDataAccessRuntime',
      latestRecordId: 42,
      earliestAvailableTimestamp: 1000,
      latestAvailableTimestamp: 2000,
      timestampAvailable: true,
      columnCount: 2,
      columnIndexCount: 2,
      columnInfoCount: 2,
      columnTypeCount: 1,
      dataArchiveParameterCount: 1,
    },
  )
})

test('rejects malformed log data-access detail rows', () => {
  assert.equal(normalizeLogDataAccessRuntimeDetail({ type: 'WLDFDataAccessRuntime' }), null)
  assert.equal(normalizeLogDataAccessRuntimeDetail(null), null)
})

test('normalizes subtype-specific archive runtime counters as nullable values', () => {
  assert.deepEqual(
    normalizeLogArchiveRuntimeCounters({
      name: 'ServerLog',
      type: 'WLDFFileArchiveRuntime',
      recordRetrievalTime: 27,
      recordSeekCount: 825,
      recordSeekTime: 39379,
      retrievedRecordCount: 1216321,
      rotatedFilesCount: 0,
      indexCycleCount: 0,
      ignored: 123,
    }),
    {
      name: 'ServerLog',
      type: 'WLDFFileArchiveRuntime',
      recordRetrievalTime: 27,
      recordSeekCount: 825,
      recordSeekTime: 39379,
      retrievedRecordCount: 1216321,
      dataRetirementCycles: null,
      dataRetirementTotalTime: null,
      lastDataRetirementStartTime: null,
      lastDataRetirementTime: null,
      retiredRecordCount: null,
      deletionCount: null,
      deletionTime: null,
      insertionCount: null,
      insertionTime: null,
      indexPageCount: null,
      recordCount: null,
      incrementalIndexCycleCount: null,
      incrementalIndexTime: null,
      indexCycleCount: 0,
      indexTime: null,
      rotatedFilesCount: 0,
    },
  )
})

test('builds bounded WLDF log record search payloads from archive timestamps', () => {
  const window = buildLogRecordSearchWindow({
    name: 'ServerLog',
    latestRecordId: 99,
    earliestAvailableTimestamp: 1000,
    latestAvailableTimestamp: 1777657580260,
    timestampAvailable: true,
  })

  assert.deepEqual(window, {
    since: '2026-05-01T17:31:20.260Z',
    until: '2026-05-01T17:46:21.260Z',
    limit: 25,
  })
  assert.deepEqual(logRecordSearchPayload(window), {
    since: '2026-05-01T17:31:20.260Z',
    until: '2026-05-01T17:46:21.260Z',
    limit: 25,
  })
  assert.deepEqual(wldfLogRecordSearchRequest('12.2.1.4.0', 'AdminServer', 'ServerLog', window), {
    params: {
      path: { version: '12.2.1.4.0', serverName: 'AdminServer', WLDFDataAccessName: 'ServerLog' },
      query: {
        internal: true,
        expandedValues: false,
        saveChanges: false,
        enableConsoleRestExtension: true,
      },
      header: { 'X-Requested-By': 'wls-cockpit' },
    },
    body: {
      since: '2026-05-01T17:31:20.260Z',
      until: '2026-05-01T17:46:21.260Z',
      limit: 25,
    },
  })
})

test('builds WLDF log record search windows from current time when metadata is absent', () => {
  const window = buildLogRecordSearchWindow(null, 1_000_000)

  assert.deepEqual(window, {
    since: '1970-01-01T00:01:40.000Z',
    until: '1970-01-01T00:16:41.000Z',
    limit: 25,
  })
})

test('builds incremental WLDF log record tail windows from the latest cursor', () => {
  const window = buildLogRecordTailSearchWindow(
    {
      name: 'ServerLog',
      latestRecordId: 99,
      earliestAvailableTimestamp: 1000,
      latestAvailableTimestamp: 1777657580260,
      timestampAvailable: true,
    },
    { latestRecordId: 55, latestTimestamp: 1777657000000 },
    1777657600000,
  )

  assert.deepEqual(window, {
    since: '2026-05-01T17:36:38.000Z',
    until: '2026-05-01T17:46:41.000Z',
    limit: 50,
  })
})

test('uses the latest archive window for the initial WLDF log record tail read', () => {
  const window = buildLogRecordTailSearchWindow(
    {
      name: 'ServerLog',
      latestRecordId: 99,
      earliestAvailableTimestamp: 1000,
      latestAvailableTimestamp: 1777657580260,
      timestampAvailable: true,
    },
    null,
    1777657600000,
  )

  assert.deepEqual(window, {
    since: '2026-05-01T17:31:20.260Z',
    until: '2026-05-01T17:46:21.260Z',
    limit: 50,
  })
})

test('normalizes WLDF log record rows defensively', () => {
  assert.deepEqual(
    normalizeLogRecordPreviewRow({
      RECORDID: 9897,
      DATE: 'May 1, 2026, 7:46:20,260 PM Central European Summer Time',
      SEVERITY: 'Info',
      SUBSYSTEM: 'WorkManager',
      MACHINE: 'localhost.localdomain',
      SERVER: 'AdminServer',
      THREAD: 'Timer-2',
      USERID: '<WLS Kernel>',
      TXID: '',
      CONTEXTID: 'context-1',
      TIMESTAMP: '1777657580260',
      MSGID: 'BEA-002959',
      MESSAGE: 'Self-tuning thread pool contains 0 running threads',
      SUPP_ATTRS: '[severity-value: 64] ',
      SEVERITY_VALUE: 64,
      RID: '0',
      ignored: 'value',
    }),
    {
      recordId: 9897,
      timestamp: 1777657580260,
      date: 'May 1, 2026, 7:46:20,260 PM Central European Summer Time',
      severity: 'Info',
      severityValue: 64,
      subsystem: 'WorkManager',
      machine: 'localhost.localdomain',
      server: 'AdminServer',
      thread: 'Timer-2',
      userId: '<WLS Kernel>',
      txId: null,
      contextId: 'context-1',
      messageId: 'BEA-002959',
      message: 'Self-tuning thread pool contains 0 running threads',
      supplementalAttributes: '[severity-value: 64]',
      rid: '0',
      httpAccess: null,
    },
  )
})

test('normalizes WLDF HTTP access rows from extended field columns', () => {
  const row = normalizeLogRecordPreviewRow({
    RECORDID: 42,
    TIMESTAMP: '1777657580260',
    date: '2026-05-06',
    time: '17:50:12',
    'time-taken': '0.018',
    'c-ip': '192.0.2.15',
    'cs-method': 'GET',
    'cs-uri': '/console/login/LoginForm.jsp',
    'sc-status': '200',
    bytes: '1234',
    'cs(User-Agent)': 'Mozilla/5.0',
    'ctx-ecid': 'ecid-1',
    'ctx-rid': 'rid-1',
  })

  assert.equal(row?.message, null)
  assert.deepEqual(parseHttpAccessLogRecord(row!), {
    raw: '2026-05-06 17:50:12 0.018 GET /console/login/LoginForm.jsp 200 1234',
    client: '192.0.2.15',
    ident: null,
    user: null,
    timestamp: '2026-05-06 17:50:12',
    date: '2026-05-06',
    time: '17:50:12',
    request: 'GET /console/login/LoginForm.jsp',
    method: 'GET',
    path: '/console/login/LoginForm.jsp',
    protocol: null,
    status: 200,
    bytes: 1234,
    host: null,
    referer: null,
    userAgent: 'Mozilla/5.0',
    durationMs: 18,
    durationSeconds: 0.018,
    ecid: 'ecid-1',
    rid: 'rid-1',
  })
})

test('merges WLDF log record tail buffers chronologically with duplicate suppression and cap', () => {
  const records = mergeLogRecordTailBuffer(
    [
      {
        recordId: 2,
        timestamp: 2000,
        date: null,
        severity: 'Info',
        severityValue: null,
        subsystem: 'A',
        machine: null,
        server: 'AdminServer',
        thread: null,
        userId: null,
        txId: null,
        contextId: null,
        messageId: 'BEA-2',
        message: 'old duplicate',
        supplementalAttributes: null,
        rid: null,
      },
      {
        recordId: 1,
        timestamp: 1000,
        date: null,
        severity: 'Info',
        severityValue: null,
        subsystem: 'A',
        machine: null,
        server: 'AdminServer',
        thread: null,
        userId: null,
        txId: null,
        contextId: null,
        messageId: 'BEA-1',
        message: 'first',
        supplementalAttributes: null,
        rid: null,
      },
    ],
    [
      {
        recordId: 2,
        timestamp: 2000,
        date: null,
        severity: 'Warning',
        severityValue: null,
        subsystem: 'A',
        machine: null,
        server: 'AdminServer',
        thread: null,
        userId: null,
        txId: null,
        contextId: null,
        messageId: 'BEA-2',
        message: 'new duplicate',
        supplementalAttributes: null,
        rid: null,
      },
      {
        recordId: 3,
        timestamp: 3000,
        date: null,
        severity: 'Error',
        severityValue: null,
        subsystem: 'B',
        machine: null,
        server: 'AdminServer',
        thread: null,
        userId: null,
        txId: null,
        contextId: null,
        messageId: 'BEA-3',
        message: 'third',
        supplementalAttributes: null,
        rid: null,
      },
    ],
    2,
  )

  assert.deepEqual(records.map((record) => record.recordId), [2, 3])
  assert.equal(records[0].message, 'new duplicate')
  assert.deepEqual(latestLogRecordTailCursor(records), { latestRecordId: 3, latestTimestamp: 3000 })
})

test('normalizes WLDF log record preview snapshots and ignores malformed rows', () => {
  const window = buildLogRecordSearchWindow(null, 1_000_000)
  const snapshot = normalizeLogRecordPreviewSnapshot('ServerLog', window, {
    records: [
      { RECORDID: 1, TIMESTAMP: '1000', SEVERITY: 'Info', MSGID: 'BEA-1', MESSAGE: 'ok' },
      { arbitrary: 'shape' },
    ],
    nextRecordId: '2',
  })

  assert.equal(snapshot.status, 'available')
  assert.equal(snapshot.archiveName, 'ServerLog')
  assert.equal(snapshot.records.length, 1)
  assert.equal(snapshot.records[0].recordId, 1)
  assert.equal(snapshot.records[0].timestamp, 1000)
  assert.equal(snapshot.nextRecordId, 2)
  assert.deepEqual(normalizeLogRecordPreviewSnapshot('ServerLog', window, null), {
    status: 'empty',
    archiveName: 'ServerLog',
    records: [],
    nextRecordId: null,
    window,
  })
})

test('normalizes plain text HTTPAccessLog search responses from WebLogic', () => {
  const window = buildLogRecordSearchWindow(null, 1_000_000)
  const snapshot = normalizeLogRecordPreviewSnapshot(
    'HTTPAccessLog',
    window,
    [
      '192.0.2.15 - - [16/Dec/2025:23:03:38 +0100] "GET /rconsole HTTP/1.1" 302 265 ',
      '192.0.2.15 - - [16/Dec/2025:23:03:38 +0100] "GET /rconsole/index.html HTTP/1.1" 200 299 ',
      'nextRecordId=7',
    ].join('\n'),
  )

  assert.equal(snapshot.status, 'available')
  assert.equal(snapshot.nextRecordId, 7)
  assert.equal(snapshot.records.length, 2)
  assert.equal(snapshot.records[0].timestamp, 1765922618000)
  assert.equal(snapshot.records[0].date, '16/Dec/2025:23:03:38 +0100')
  assert.equal(snapshot.records[0].message, '192.0.2.15 - - [16/Dec/2025:23:03:38 +0100] "GET /rconsole HTTP/1.1" 302 265')
  assert.deepEqual(parseHttpAccessLogRecord(snapshot.records[0]), {
    raw: '192.0.2.15 - - [16/Dec/2025:23:03:38 +0100] "GET /rconsole HTTP/1.1" 302 265',
    client: '192.0.2.15',
    ident: null,
    user: null,
    timestamp: '16/Dec/2025:23:03:38 +0100',
    date: null,
    time: null,
    request: 'GET /rconsole HTTP/1.1',
    method: 'GET',
    path: '/rconsole',
    protocol: 'HTTP/1.1',
    status: 302,
    bytes: 265,
    host: null,
    referer: null,
    userAgent: null,
    durationMs: null,
    durationSeconds: null,
    ecid: null,
    rid: null,
  })
})

test('parses common HTTP access log messages for tail presentation', () => {
  const parsed = parseHttpAccessLogMessage(
    '192.0.2.15 - admin [06/May/2026:12:34:56 +0200] "GET /console/login/LoginForm.jsp HTTP/1.1" 200 1234 "http://example.test/console" "Mozilla/5.0" 37',
  )

  assert.deepEqual(parsed, {
    raw: '192.0.2.15 - admin [06/May/2026:12:34:56 +0200] "GET /console/login/LoginForm.jsp HTTP/1.1" 200 1234 "http://example.test/console" "Mozilla/5.0" 37',
    client: '192.0.2.15',
    ident: null,
    user: 'admin',
    timestamp: '06/May/2026:12:34:56 +0200',
    date: null,
    time: null,
    request: 'GET /console/login/LoginForm.jsp HTTP/1.1',
    method: 'GET',
    path: '/console/login/LoginForm.jsp',
    protocol: 'HTTP/1.1',
    status: 200,
    bytes: 1234,
    host: null,
    referer: 'http://example.test/console',
    userAgent: 'Mozilla/5.0',
    durationMs: 37,
    durationSeconds: null,
    ecid: null,
    rid: null,
  })
})

test('parses compact HTTP access log messages and ignores non-access messages', () => {
  assert.deepEqual(parseHttpAccessLogMessage('POST /management/weblogic/latest/domainRuntime HTTP/1.1 401 512'), {
    raw: 'POST /management/weblogic/latest/domainRuntime HTTP/1.1 401 512',
    client: null,
    ident: null,
    user: null,
    timestamp: null,
    date: null,
    time: null,
    request: 'POST /management/weblogic/latest/domainRuntime HTTP/1.1',
    method: 'POST',
    path: '/management/weblogic/latest/domainRuntime',
    protocol: 'HTTP/1.1',
    status: 401,
    bytes: 512,
    host: null,
    referer: null,
    userAgent: null,
    durationMs: null,
    durationSeconds: null,
    ecid: null,
    rid: null,
  })
  assert.equal(parseHttpAccessLogMessage('Self-tuning thread pool contains 0 running threads'), null)
  assert.equal(parseHttpAccessLogMessage(null), null)
})

test('parses access log duration when referer and agent are absent', () => {
  assert.deepEqual(
    parseHttpAccessLogMessage('192.0.2.15 - - [06/May/2026:12:34:56 +0200] "GET /console HTTP/1.1" 302 0 19'),
    {
      raw: '192.0.2.15 - - [06/May/2026:12:34:56 +0200] "GET /console HTTP/1.1" 302 0 19',
      client: '192.0.2.15',
      ident: null,
      user: null,
      timestamp: '06/May/2026:12:34:56 +0200',
      date: null,
      time: null,
      request: 'GET /console HTTP/1.1',
      method: 'GET',
      path: '/console',
      protocol: 'HTTP/1.1',
      status: 302,
      bytes: 0,
      host: null,
      referer: null,
      userAgent: null,
      durationMs: 19,
      durationSeconds: null,
      ecid: null,
      rid: null,
    },
  )
})

test('builds partial log detail metadata snapshots without dropping fulfilled families', () => {
  const snapshot = buildLogDetailMetadataSnapshot(
    'AdminServer',
    {
      status: 'fulfilled',
      value: [
        {
          name: 'ServerLog',
          type: 'WLDFDataAccessRuntime',
          latestRecordId: 42,
          earliestAvailableTimestamp: 1000,
          latestAvailableTimestamp: 2000,
          timestampAvailable: true,
          columnCount: null,
          columnIndexCount: null,
          columnInfoCount: null,
          columnTypeCount: null,
          dataArchiveParameterCount: null,
        },
      ],
    },
    { status: 'rejected', reason: new Error('HTTP 404 Not Found') },
  )

  assert.equal(snapshot.status, 'partial')
  assert.equal(snapshot.dataAccessRuntimes.length, 1)
  assert.deepEqual(snapshot.archiveRuntimes, [])
  assert.deepEqual(snapshot.partialFailures, [
    { serverName: 'AdminServer', signal: 'archiveRuntimes', message: 'HTTP 404 Not Found' },
  ])
})

test('treats optional 404 archive runtime counters as empty metadata', () => {
  const snapshot = buildLogDetailMetadataSnapshot(
    'AdminServer',
    {
      status: 'fulfilled',
      value: [
        {
          name: 'ServerLog',
          type: 'WLDFDataAccessRuntime',
          latestRecordId: 42,
          earliestAvailableTimestamp: 1000,
          latestAvailableTimestamp: 2000,
          timestampAvailable: true,
          columnCount: null,
          columnIndexCount: null,
          columnInfoCount: null,
          columnTypeCount: null,
          dataArchiveParameterCount: null,
        },
      ],
    },
    {
      status: 'rejected',
      reason: new WlsRestError({
        kind: 'http',
        operation: 'Log archive runtimes AdminServer',
        status: 404,
        statusText: 'Not Found',
        message: 'Log archive runtimes AdminServer: HTTP 404 Not Found',
      }),
    },
    {
      isOptionalArchiveRuntimeFailure: (error) => error instanceof WlsRestError && error.status === 404,
    },
  )

  assert.equal(snapshot.status, 'available')
  assert.equal(snapshot.dataAccessRuntimes.length, 1)
  assert.deepEqual(snapshot.archiveRuntimes, [])
  assert.deepEqual(snapshot.partialFailures, [])
})

test('keeps non-404 archive runtime counter failures as partial metadata', () => {
  const snapshot = buildLogDetailMetadataSnapshot(
    'AdminServer',
    {
      status: 'fulfilled',
      value: [
        {
          name: 'ServerLog',
          type: 'WLDFDataAccessRuntime',
          latestRecordId: 42,
          earliestAvailableTimestamp: 1000,
          latestAvailableTimestamp: 2000,
          timestampAvailable: true,
          columnCount: null,
          columnIndexCount: null,
          columnInfoCount: null,
          columnTypeCount: null,
          dataArchiveParameterCount: null,
        },
      ],
    },
    {
      status: 'rejected',
      reason: new WlsRestError({
        kind: 'http',
        operation: 'Log archive runtimes AdminServer',
        status: 500,
        statusText: 'Internal Server Error',
        message: 'Log archive runtimes AdminServer: HTTP 500 Internal Server Error',
      }),
    },
    {
      isOptionalArchiveRuntimeFailure: (error) => error instanceof WlsRestError && error.status === 404,
    },
  )

  assert.equal(snapshot.status, 'partial')
  assert.deepEqual(snapshot.partialFailures, [
    {
      serverName: 'AdminServer',
      signal: 'archiveRuntimes',
      message: 'Log archive runtimes AdminServer: HTTP 500 Internal Server Error',
    },
  ])
})

test('builds selected log detail snapshots without aggregate list state', () => {
  const snapshot = buildSelectedLogRuntimeSnapshot(
    'AdminServer',
    'RUNNING',
    { status: 'fulfilled', value: 42 },
    { status: 'fulfilled', value: true },
    {
      status: 'fulfilled',
      value: [
        {
          name: 'ServerLog',
          latestRecordId: 10,
          earliestAvailableTimestamp: 1000,
          latestAvailableTimestamp: 2000,
          timestampAvailable: true,
        },
      ],
    },
  )

  assert.equal(snapshot.status, 'available')
  assert.equal(snapshot.row?.serverName, 'AdminServer')
  assert.equal(snapshot.row?.state, 'RUNNING')
  assert.equal(snapshot.row?.messagesLogged, 42)
  assert.equal(snapshot.row?.serverLogLatestTimestamp, 2000)
  assert.equal(snapshot.row?.severity, 'healthy')
  assert.deepEqual(snapshot.partialFailures, [])
})

test('selected log detail snapshots preserve fulfilled families on partial failure', () => {
  const snapshot = buildSelectedLogRuntimeSnapshot(
    'AdminServer',
    'RUNNING',
    { status: 'rejected', reason: new Error('HTTP 404 Not Found') },
    { status: 'fulfilled', value: true },
    { status: 'fulfilled', value: [] },
  )

  assert.equal(snapshot.status, 'partial')
  assert.equal(snapshot.row?.serverName, 'AdminServer')
  assert.equal(snapshot.row?.messagesLogged, null)
  assert.equal(snapshot.row?.serverLogAvailable, true)
  assert.equal(snapshot.row?.severity, 'warning')
  assert.deepEqual(snapshot.partialFailures, [
    { serverName: 'AdminServer', signal: 'broadcaster', message: 'HTTP 404 Not Found' },
  ])
})

test('selected log detail snapshots return no row when every selected signal fails', () => {
  const snapshot = buildSelectedLogRuntimeSnapshot(
    'server1',
    'UNKNOWN',
    { status: 'rejected', reason: new Error('broadcaster unavailable') },
    { status: 'rejected', reason: new Error('server log unavailable') },
    { status: 'rejected', reason: new Error('archives unavailable') },
  )

  assert.equal(snapshot.status, 'partial')
  assert.equal(snapshot.row, null)
  assert.deepEqual(
    snapshot.partialFailures.map((failure) => failure.signal),
    ['broadcaster', 'serverLog', 'archives'],
  )
})

test('merges cached archive summaries into log signal rows', () => {
  const rows: Parameters<typeof applyLogArchiveSummaries>[0] = [
    {
      id: 'AdminServer',
      serverName: 'AdminServer',
      state: 'RUNNING',
      messagesLogged: 42,
      logFileStreamOpened: true,
      broadcasterAvailable: true,
      serverLogAvailable: true,
      archives: [],
      serverLogLatestTimestamp: null,
      severity: 'healthy',
    },
    {
      id: 'server1',
      serverName: 'server1',
      state: 'RUNNING',
      messagesLogged: 7,
      logFileStreamOpened: true,
      broadcasterAvailable: true,
      serverLogAvailable: true,
      archives: [],
      serverLogLatestTimestamp: null,
      severity: 'healthy',
    },
  ]

  const merged = applyLogArchiveSummaries(
    rows,
    new Map([
      [
        'AdminServer',
        [
          {
            name: 'ServerLog',
            latestRecordId: 10,
            earliestAvailableTimestamp: 1000,
            latestAvailableTimestamp: 2000,
            timestampAvailable: true,
          },
          {
            name: 'DomainLog',
            latestRecordId: 20,
            earliestAvailableTimestamp: 1200,
            latestAvailableTimestamp: 2400,
            timestampAvailable: true,
          },
        ],
      ],
    ]),
  )

  assert.equal(merged[0].archives.length, 2)
  assert.equal(merged[0].serverLogLatestTimestamp, 2000)
  assert.equal(merged[0].severity, 'healthy')
  assert.equal(merged[1], rows[1])
})

test('14.1.2 access log records in common log format keep method, path, status, bytes and time', async () => {
  const { normalizeLogRecordPreviewRow, parseHttpAccessLogRecord } = await import('../src/api/queries/log-runtime-detail-normalization.ts')
  const row = normalizeLogRecordPreviewRow({
    RECORDID: 430,
    HOST: '127.0.0.1',
    REMOTEUSER: '-',
    AUTHUSER: '-',
    TIMESTAMP: '16/Dec/2025:18:55:52 +0100',
    REQUEST: 'GET /console/login HTTP/2',
    STATUS: '404',
    BYTECOUNT: '1164',
  })
  assert.ok(row)
  assert.equal(row.timestamp, Date.UTC(2025, 11, 16, 17, 55, 52))
  const access = parseHttpAccessLogRecord(row)
  assert.equal(access?.method, 'GET')
  assert.equal(access?.path, '/console/login')
  assert.equal(access?.protocol, 'HTTP/2')
  assert.equal(access?.status, 404)
  assert.equal(access?.bytes, 1164)
})
