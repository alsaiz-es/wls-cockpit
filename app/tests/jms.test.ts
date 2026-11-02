import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { tmpdir } from 'node:os'
import {
  jmsDestinationsQueryParams,
  jmsServersQueryParams,
  formatJmsMessageDeleteFeedback,
  formatJmsMessageProduceFeedback,
  jmsDestinationPauseOperationAvailable,
  jmsDestinationPauseOperationPath,
  jmsPausedStateLabel,
  jmsPausedValue,
  jmsPauseOperationName,
  normalizeJmsBrowseUrlState,
  normalizeJmsMessageBrowseSnapshot,
  normalizeJmsMessageDeleteResult,
  normalizeJmsMessageDetailResult,
  normalizeJmsMessageProduceResult,
  normalizeJmsRuntimeRow,
  serializeJmsBrowseUrlState,
  unsupportedJmsMessageBrowseSnapshot,
} from '../src/api/queries/jms-normalization.ts'
import { normalizeWlsTarget } from '../src/api/proxy-target.ts'
import { buildExactMessageIdSelector, helperDeleteRequest, helperProduceRequest, validateJmsBrowsePayload, validateJmsDeletePayload, validateJmsDetailPayload, validateJmsProducePayload } from '../server/jms-jmx-contract.ts'
import { discoverJmsJmxConfig } from '../server/jms-jmx-config.ts'
import { helperBuildDir } from '../server/jms-jmx.ts'
import { helperDiagnostics, JmsJmxInvocationError, jmsJmxErrorResponse, latestHelperPhase } from '../server/jms-jmx.ts'

test('JMS field allow-lists stay bounded and link-free', () => {
  assert.equal(jmsServersQueryParams().links, 'none')
  assert.equal(jmsDestinationsQueryParams().links, 'none')
  assert.match(jmsServersQueryParams().fields, /messagesCurrentCount/)
  assert.match(jmsDestinationsQueryParams().fields, /consumersCurrentCount/)
  assert.doesNotMatch(jmsDestinationsQueryParams().fields, /durableSubscribers|tasks|messages\*/)
})

test('normalizes destination counters and classifies zero-consumer backlog', () => {
  const row = normalizeJmsRuntimeRow({
    serverName: 'AdminServer',
    jmsServerName: 'DemoJMSServer',
    item: {
      name: 'OrdersQueue',
      destinationType: 'Queue',
      state: 'running',
      messagesCurrentCount: 7,
      messagesPendingCount: 0,
      messagesHighCount: 12,
      messagesReceivedCount: 31,
      bytesCurrentCount: 1024,
      consumersCurrentCount: 0,
      consumptionPaused: false,
      productionPaused: false,
      insertionPaused: false,
      consumptionPausedState: 'Consumption-Enabled',
      productionPausedState: 'Production-Enabled',
      insertionPausedState: 'Insertion-Enabled',
    },
  })

  assert.equal(row?.id, 'AdminServer:DemoJMSServer:OrdersQueue')
  assert.equal(row?.kind, 'destination')
  assert.equal(row?.messagesCurrentCount, 7)
  assert.equal(row?.consumersCurrentCount, 0)
  assert.equal(row?.severity, 'warning')
})

test('normalizes JMS server fallback rows when destination collection is partial', () => {
  const row = normalizeJmsRuntimeRow({
    serverName: 'AdminServer',
    jmsServerName: 'DemoJMSServer',
    destinationName: null,
    item: {
      name: 'DemoJMSServer',
      destinationsCurrentCount: 2,
      messagesCurrentCount: 0,
      messagesPendingCount: 0,
      consumptionPaused: false,
      productionPaused: false,
      insertionPaused: false,
    },
  })

  assert.equal(row?.id, 'AdminServer:DemoJMSServer:__jmsServer')
  assert.equal(row?.kind, 'jmsServer')
  assert.equal(row?.destinationName, null)
  assert.equal(row?.destinationsCurrentCount, 2)
})

test('message browsing is unsupported until a standard read-only operation is verified', async () => {
  const snapshot = unsupportedJmsMessageBrowseSnapshot('AdminServer', 'DemoJMSServer', 'Timed out during JMS JMX phase getItems.', [
    'WLS_COCKPIT_JMS_JMX phase=getItems event=start',
  ])

  assert.equal(snapshot.support, 'unsupported')
  assert.deepEqual(snapshot.messages, [])
  assert.equal(snapshot.partialFailures[0].family, 'messages')
  assert.equal(snapshot.partialFailures[0].message, 'Timed out during JMS JMX phase getItems.')
  assert.deepEqual(snapshot.partialFailures[0].details, ['WLS_COCKPIT_JMS_JMX phase=getItems event=start'])
})

test('JMS JMX config discovers explicit classpath and reports missing local client support', async () => {
  assert.deepEqual(discoverJmsJmxConfig({ WLS_COCKPIT_WLS_CLIENT_CLASSPATH: '/opt/wls/client.jar' }), {
    available: true,
    javaCommand: 'java',
    javacCommand: 'javac',
    classpath: '/opt/wls/client.jar',
    reason: null,
  })

  const missing = discoverJmsJmxConfig({})
  assert.equal(missing.available, false)
  assert.match(missing.reason ?? '', /WLS_COCKPIT_WLS_CLIENT_CLASSPATH/)
  assert.match(missing.reason ?? '', /ORACLE_HOME/)
  assert.match(missing.reason ?? '', /wlthint3client\.jar/)
})

test('JMS JMX config discovers version-matched thin T3 client from WebLogic homes', async (t) => {
  const wlHome = await mkdtemp(join(tmpdir(), 'wls-cockpit-wl-home-'))
  t.after(() => rm(wlHome, { recursive: true, force: true }))
  const serverLib = join(wlHome, 'server', 'lib')
  await mkdir(serverLib, { recursive: true })
  await writeFile(join(serverLib, 'wlthint3client.jar'), '')

  assert.deepEqual(discoverJmsJmxConfig({ WLS_COCKPIT_WL_HOME: wlHome }), {
    available: true,
    javaCommand: 'java',
    javacCommand: 'javac',
    classpath: join(serverLib, 'wlthint3client.jar'),
    reason: null,
  })

  assert.deepEqual(discoverJmsJmxConfig({ WL_HOME: wlHome }), {
    available: true,
    javaCommand: 'java',
    javacCommand: 'javac',
    classpath: join(serverLib, 'wlthint3client.jar'),
    reason: null,
  })
})

test('JMS JMX config discovers thin T3 client from ORACLE_HOME and preserves explicit precedence', async (t) => {
  const oracleHome = await mkdtemp(join(tmpdir(), 'wls-cockpit-oracle-home-'))
  t.after(() => rm(oracleHome, { recursive: true, force: true }))
  const serverLib = join(oracleHome, 'wlserver', 'server', 'lib')
  await mkdir(serverLib, { recursive: true })
  await writeFile(join(serverLib, 'wlthint3client.jar'), '')

  assert.deepEqual(discoverJmsJmxConfig({ ORACLE_HOME: oracleHome }), {
    available: true,
    javaCommand: 'java',
    javacCommand: 'javac',
    classpath: join(serverLib, 'wlthint3client.jar'),
    reason: null,
  })

  assert.deepEqual(
    discoverJmsJmxConfig({
      WLS_COCKPIT_WLS_CLIENT_CLASSPATH: '/explicit/client.jar',
      ORACLE_HOME: oracleHome,
    }),
    {
      available: true,
      javaCommand: 'java',
      javacCommand: 'javac',
      classpath: '/explicit/client.jar',
      reason: null,
    },
  )
})

test('JMS JMX helper diagnostics preserve bounded phases without stderr leaks', () => {
  const diagnostics = helperDiagnostics(
    [
      'WARNING: noisy JVM line with password=secret',
      'WLS_COCKPIT_JMS_JMX phase=connect operation=browse event=start',
      'WLS_COCKPIT_JMS_JMX phase=connect event=ok elapsedMs=12',
      'WLS_COCKPIT_JMS_JMX phase=getItems event=start target=http://wls-admin.example.com:7001 path=/Users/example/secret password=secret',
      'Exception: /Users/example/secret',
    ].join('\n'),
  )

  assert.deepEqual(diagnostics, [
    'WLS_COCKPIT_JMS_JMX phase=connect operation=browse event=start',
    'WLS_COCKPIT_JMS_JMX phase=connect event=ok elapsedMs=12',
    'WLS_COCKPIT_JMS_JMX phase=getItems event=start target=<target> path=<path> password=<redacted>',
  ])
  assert.equal(latestHelperPhase(diagnostics), 'getItems')
})

test('JMS JMX timeout errors expose phase diagnostics without changing status', () => {
  const mapped = jmsJmxErrorResponse(
    new JmsJmxInvocationError('JMS_JMX_TIMEOUT', 'Timed out during JMS JMX phase getItems while querying JMS messages over JMX/T3.', 504, true, {
      phase: 'getItems',
      diagnostics: ['WLS_COCKPIT_JMS_JMX phase=getItems event=start'],
    }),
  )

  assert.equal(mapped.status, 504)
  assert.deepEqual(mapped.body.error, {
    code: 'JMS_JMX_TIMEOUT',
    message: 'Timed out during JMS JMX phase getItems while querying JMS messages over JMX/T3.',
    retryable: true,
    phase: 'getItems',
    diagnostics: ['WLS_COCKPIT_JMS_JMX phase=getItems event=start'],
  })
})

test('JMS JMX browse and delete payload validation stays narrow', () => {
  assert.equal(
    validateJmsBrowsePayload({
      serverName: 'AdminServer',
      jmsServerName: 'DemoJMSServer',
      destinationName: 'DemoModule!OrdersQueue',
      offset: 5,
      limit: 50,
      selector: "JMSPriority > 4",
    }).ok,
    true,
  )
  assert.equal(validateJmsBrowsePayload({ serverName: 'AdminServer', jmsServerName: 'DemoJMSServer', destinationName: 'Queue', limit: 500 }).ok, false)
  assert.equal(validateJmsDeletePayload({ serverName: 'AdminServer', jmsServerName: 'DemoJMSServer', destinationName: 'Queue', selector: '1=1' }).ok, false)
  assert.equal(
    validateJmsDeletePayload({ serverName: 'AdminServer', jmsServerName: 'DemoJMSServer', destinationName: 'Queue', messageId: 'ID:1' }).ok,
    true,
  )
  assert.equal(
    validateJmsDeletePayload({ serverName: 'AdminServer', jmsServerName: 'DemoJMSServer', destinationName: 'Queue', messageIds: ['ID:1', 'ID:2'] }).ok,
    true,
  )
  assert.equal(
    validateJmsDeletePayload({
      serverName: 'AdminServer',
      jmsServerName: 'DemoJMSServer',
      destinationName: 'Queue',
      messageIds: Array.from({ length: 51 }, (_, index) => `ID:${index}`),
    }).ok,
    false,
  )
  assert.equal(
    validateJmsDeletePayload({ serverName: 'AdminServer', jmsServerName: 'DemoJMSServer', destinationName: 'Queue', messageIds: ['ID:1', 'ID:1'] }).ok,
    false,
  )
  assert.equal(validateJmsDetailPayload({ serverName: 'AdminServer', jmsServerName: 'DemoJMSServer', destinationName: 'Queue', selector: '1=1' }).ok, false)
  assert.equal(
    validateJmsDetailPayload({ serverName: 'AdminServer', jmsServerName: 'DemoJMSServer', destinationName: 'Queue', messageId: 'ID:1' }).ok,
    true,
  )
  const produce = validateJmsProducePayload({
    serverName: 'AdminServer',
    jmsServerName: 'DemoJMSServer',
    destinationName: 'Queue',
    destinationType: 'Queue',
    body: 'hello',
    correlationId: 'corr-1',
    properties: { tenant: 'demo' },
    priority: 4,
    deliveryMode: 'NON_PERSISTENT',
    ttlMillis: 1000,
  })
  assert.equal(produce.ok, true)
  assert.equal(validateJmsProducePayload({ serverName: 'AdminServer', jmsServerName: 'DemoJMSServer', destinationName: 'Queue', destinationType: 'Topic', body: 'hello' }).ok, false)
  assert.equal(validateJmsProducePayload({ serverName: 'AdminServer', jmsServerName: 'DemoJMSServer', destinationName: 'Queue', destinationType: 'Queue', body: '' }).ok, false)
  assert.equal(validateJmsProducePayload({ serverName: 'AdminServer', jmsServerName: 'DemoJMSServer', destinationName: 'Queue', destinationType: 'Queue', body: 'hello', selector: '1=1' }).ok, false)
  assert.equal(validateJmsProducePayload({ serverName: 'AdminServer', jmsServerName: 'DemoJMSServer', destinationName: 'Queue', destinationType: 'Queue', body: 'hello', properties: { '1bad': 'x' } }).ok, false)
  assert.equal(validateJmsProducePayload({ serverName: 'AdminServer', jmsServerName: 'DemoJMSServer', destinationName: 'Queue', destinationType: 'Queue', body: 'x'.repeat(32_769) }).ok, false)
  assert.equal(validateJmsProducePayload({ serverName: 'AdminServer', jmsServerName: 'DemoJMSServer', destinationName: 'Queue', destinationType: 'Queue', body: 'hello', correlationId: 'x'.repeat(257) }).ok, false)
  assert.equal(validateJmsProducePayload({ serverName: 'AdminServer', jmsServerName: 'DemoJMSServer', destinationName: 'Queue', destinationType: 'Queue', body: 'hello', priority: 10 }).ok, false)
  assert.equal(validateJmsProducePayload({ serverName: 'AdminServer', jmsServerName: 'DemoJMSServer', destinationName: 'Queue', destinationType: 'Queue', body: 'hello', ttlMillis: 86_400_001 }).ok, false)
  assert.equal(
    validateJmsProducePayload({
      serverName: 'AdminServer',
      jmsServerName: 'DemoJMSServer',
      destinationName: 'Queue',
      destinationType: 'Queue',
      body: 'hello',
      properties: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`p${index}`, 'x'])),
    }).ok,
    false,
  )
  assert.equal(buildExactMessageIdSelector("ID:a'b"), "JMSMessageID = 'ID:a''b'")
})

test('JMS delete helper request carries only selected message ids', () => {
  const target = normalizeWlsTarget('http://wls-admin.example.com:7001')
  assert.equal(target.ok, true)
  if (!target.ok) throw new Error(target.error)
  const payload = validateJmsDeletePayload({
    serverName: 'AdminServer',
    jmsServerName: 'DemoJMSServer',
    destinationName: 'Queue',
    messageIds: ['ID:1', 'ID:2'],
  })
  assert.equal(payload.ok, true)
  if (!payload.ok) throw new Error(payload.message)

  assert.deepEqual(helperDeleteRequest({ target, auth: { username: 'admin', password: 'secret' }, payload: payload.value }), {
    operation: 'delete',
    targetUrl: 'http://wls-admin.example.com:7001',
    username: 'admin',
    password: 'secret',
    serverName: 'AdminServer',
    jmsServerName: 'DemoJMSServer',
    destinationName: 'Queue',
    messageIds: ['ID:1', 'ID:2'],
  })
})

test('JMS destination pause helpers build only verified runtime operation paths', () => {
  const row = normalizeJmsRuntimeRow({
    serverName: 'AdminServer',
    jmsServerName: 'DemoJMSServer',
    item: {
      name: 'DemoModule!OrdersQueue',
      destinationType: 'Queue',
      productionPaused: false,
      productionPausedState: 'Production-Enabled',
      consumptionPaused: false,
      insertionPaused: null,
    },
  })
  assert.ok(row)
  assert.equal(jmsDestinationPauseOperationAvailable(row, 'production'), true)
  assert.equal(jmsDestinationPauseOperationAvailable(row, 'insertion'), false)
  assert.equal(jmsPausedValue(row, 'production'), false)
  assert.equal(jmsPausedStateLabel(row, 'production'), 'Production-Enabled')
  assert.equal(jmsPauseOperationName('production', 'pause'), 'pauseProduction')
  assert.equal(
    jmsDestinationPauseOperationPath({
      version: '14.1.2.0.0',
      serverName: 'AdminServer',
      jmsServerName: 'DemoJMSServer',
      destinationName: 'DemoModule!OrdersQueue',
      dimension: 'production',
      action: 'resume',
    }),
    '/management/weblogic/14.1.2.0.0/domainRuntime/serverRuntimes/AdminServer/JMSRuntime/JMSServers/DemoJMSServer/destinations/DemoModule!OrdersQueue/resumeProduction',
  )
})

test('JMS browse URL state stays bounded and omits defaults', () => {
  const params = new URLSearchParams({
    selector: "JMSCorrelationID = 'abc'",
    offset: '50',
    limit: '10',
  })
  assert.deepEqual(normalizeJmsBrowseUrlState(params), {
    selector: "JMSCorrelationID = 'abc'",
    offset: 50,
    limit: 10,
  })
  assert.equal(
    serializeJmsBrowseUrlState({ selector: "JMSCorrelationID = 'abc'", offset: 50, limit: 10 }).toString(),
    "selector=JMSCorrelationID+%3D+%27abc%27&offset=50&limit=10",
  )
  assert.equal(serializeJmsBrowseUrlState({ selector: '', offset: 0, limit: 25 }).toString(), '')
  assert.deepEqual(
    normalizeJmsBrowseUrlState(new URLSearchParams({ selector: 'x'.repeat(1001), offset: '-1', limit: '500' })),
    { selector: '', offset: 0, limit: 25 },
  )
})

test('JMS produce helper request carries only the bounded producer operation shape', () => {
  const target = normalizeWlsTarget('http://wls-admin.example.com:7001')
  assert.equal(target.ok, true)
  if (!target.ok) throw new Error(target.error)
  const payload = validateJmsProducePayload({
    serverName: 'AdminServer',
    jmsServerName: 'DemoJMSServer',
    destinationName: 'Queue',
    destinationType: 'Queue',
    body: 'hello',
    correlationId: 'corr-1',
    properties: { tenant: 'demo' },
    priority: 7,
    deliveryMode: 'PERSISTENT',
    ttlMillis: 5000,
  })
  assert.equal(payload.ok, true)
  if (!payload.ok) throw new Error(payload.message)

  assert.deepEqual(helperProduceRequest({ target, auth: { username: 'admin', password: 'secret' }, payload: payload.value }), {
    operation: 'produce',
    targetUrl: 'http://wls-admin.example.com:7001',
    username: 'admin',
    password: 'secret',
    serverName: 'AdminServer',
    jmsServerName: 'DemoJMSServer',
    destinationName: 'Queue',
    destinationType: 'Queue',
    body: 'hello',
    correlationId: 'corr-1',
    properties: { tenant: 'demo' },
    priority: 7,
    deliveryMode: 'PERSISTENT',
    ttlMillis: 5000,
  })
})

test('JMS producer feedback reports safe metadata without body echo', () => {
  assert.equal(
    formatJmsMessageProduceFeedback({
      accepted: true,
      correlationId: 'corr-1',
      messageSize: 42,
      propertyCount: 2,
      priority: 7,
      deliveryMode: 'PERSISTENT',
      ttlMillis: 5000,
    }),
    'Message accepted: correlation corr-1 · size 42 · properties 2 · priority 7 · delivery PERSISTENT · TTL 5s.',
  )
  assert.equal(
    formatJmsMessageProduceFeedback({
      accepted: false,
      correlationId: null,
      messageSize: null,
      propertyCount: null,
      priority: null,
      deliveryMode: null,
      ttlMillis: null,
    }),
    'Message send completed without an accepted flag.',
  )
})

test('JMS delete feedback reports bounded counts without payload data', () => {
  assert.equal(
    formatJmsMessageDeleteFeedback({
      requestedCount: 3,
      deletedCount: 2,
      failedCount: 0,
      staleCount: 1,
      stale: false,
    }),
    'Deleted 2 of 3 selected messages; 1 were already gone.',
  )
  assert.equal(
    formatJmsMessageDeleteFeedback({
      requestedCount: 2,
      deletedCount: 1,
      failedCount: 1,
      staleCount: 0,
      stale: false,
    }),
    'Delete completed partially: 1 of 2 deleted, 1 failed, 0 already gone.',
  )
})

test('normalizes JMX browsed rows and delete results', () => {
  const snapshot = normalizeJmsMessageBrowseSnapshot({
    serverName: 'AdminServer',
    jmsServerName: 'DemoJMSServer',
    selector: '',
    offset: 0,
    limit: 25,
    input: {
      ok: true,
      operation: 'browse',
      cursorSize: 1,
      messages: [
        {
          messageId: 'ID:abc',
          correlationId: 'corr-1',
          state: 'visible',
          messageSize: 128,
          sequenceNumber: 3,
          bodyIncluded: true,
          bodyText: 'must not leak into browse rows',
          messageXmlText: '<JMSMessage><Body>must not leak</Body></JMSMessage>',
          headers: { JMSReplyTo: 'secret-reply-to' },
          properties: { count: 1, names: ['tenant'] },
          propertyValues: { tenant: 'secret-value' },
          deleteCapable: true,
        },
      ],
    },
  })

  assert.equal(snapshot.support, 'supported')
  assert.equal(snapshot.cursorSize, 1)
  assert.equal(snapshot.messages[0].messageId, 'ID:abc')
  assert.equal(snapshot.messages[0].deleteCapable, true)
  assert.deepEqual(snapshot.messages[0].properties.names, ['tenant'])
  assert.equal('bodyPreview' in snapshot.messages[0], false)
  assert.equal('bodyText' in snapshot.messages[0], false)
  assert.equal('messageXmlText' in snapshot.messages[0], false)
  assert.equal('propertyValues' in snapshot.messages[0], false)

  const detail = normalizeJmsMessageDetailResult({
    ok: true,
    operation: 'detail',
    message: {
      messageId: 'ID:abc',
      bodyIncluded: false,
      messageXmlText: '<JMSMessage><JMSMessageBody>payload</JMSMessageBody></JMSMessage>',
      bodyText: 'payload',
      bodyUnavailableReason: 'WebLogic did not include the message body in this JMX response.',
    },
  })
  assert.equal(detail.message?.messageId, 'ID:abc')
  assert.equal(detail.message?.bodyText, 'payload')
  assert.match(detail.message?.messageXmlText ?? '', /JMSMessage/)
  assert.deepEqual(normalizeJmsMessageDeleteResult({ ok: true, operation: 'delete', requestedCount: 2, deletedCount: 1, failedCount: 0, staleCount: 1, stale: false }), {
    requestedCount: 2,
    deletedCount: 1,
    failedCount: 0,
    staleCount: 1,
    stale: false,
  })
  assert.deepEqual(normalizeJmsMessageDeleteResult({ ok: true, operation: 'delete', deletedCount: 0, stale: true }), {
    requestedCount: 1,
    deletedCount: 0,
    failedCount: 0,
    staleCount: 0,
    stale: true,
  })
  assert.deepEqual(normalizeJmsMessageProduceResult({ ok: true, operation: 'produce', accepted: true, correlationId: 'corr-1', messageSize: 5, propertyCount: 1, priority: 4, deliveryMode: 'NON_PERSISTENT', ttlMillis: 1000 }), {
    accepted: true,
    correlationId: 'corr-1',
    messageSize: 5,
    propertyCount: 1,
    priority: 4,
    deliveryMode: 'NON_PERSISTENT',
    ttlMillis: 1000,
  })
})

test('JMS JMX helper compiles into a private per-user cache keyed by source content', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'wls-cockpit-data-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const sourceA = join(dataDir, 'A.java')
  const sourceB = join(dataDir, 'B.java')
  await writeFile(sourceA, 'class A {}')
  await writeFile(sourceB, 'class B {}')
  const env = { WLS_COCKPIT_DATA_DIR: dataDir }

  const dirA = await helperBuildDir(sourceA, env)
  assert.equal(dirname(dirA), join(dataDir, 'jms-jmx-helper'))
  assert.notEqual(dirA, await helperBuildDir(sourceB, env))
  assert.equal(dirA, await helperBuildDir(sourceA, env))
  if (process.platform !== 'win32') assert.equal((await stat(dirname(dirA))).mode & 0o777, 0o700)
})

test('JMS helper requests spell out default ports, which a URL origin drops', async () => {
  const { helperTargetUrl } = await import('../server/jms-jmx-contract.ts')
  const { normalizeWlsTarget } = await import('../src/api/proxy-target.ts')
  const plain = normalizeWlsTarget('http://wls-admin.example.com')
  const tls = normalizeWlsTarget('https://wls-admin.example.com/')
  const custom = normalizeWlsTarget('http://wls-admin.example.com:7001')
  assert.ok(plain.ok && tls.ok && custom.ok)
  if (!plain.ok || !tls.ok || !custom.ok) return
  assert.equal(plain.targetUrl, 'http://wls-admin.example.com')
  assert.equal(helperTargetUrl(plain), 'http://wls-admin.example.com:80')
  assert.equal(helperTargetUrl(tls), 'https://wls-admin.example.com:443')
  assert.equal(helperTargetUrl(custom), 'http://wls-admin.example.com:7001')
})

test('JNDI over T3 accepts only WebLogic server names', async () => {
  const { validateJndiPayload } = await import('../server/jms-jmx-contract.ts')
  assert.deepEqual(validateJndiPayload({ serverName: 'osb_server1' }), { ok: true, value: { serverName: 'osb_server1' } })
  assert.equal(validateJndiPayload({ serverName: 'a,Type=*' }).ok, false)
  assert.equal(validateJndiPayload({}).ok, false)
})

test('the helper JVM opens java.base packages the T3 client needs on JDK 17+', async () => {
  const { helperJavaEnv } = await import('../server/jms-jmx.ts')
  const env = helperJavaEnv({ JDK_JAVA_OPTIONS: '-Xmx256m' })
  assert.match(env.JDK_JAVA_OPTIONS ?? '', /^-Xmx256m --add-opens=java\.base\/java\.io=ALL-UNNAMED/)
  assert.match(helperJavaEnv({}).JDK_JAVA_OPTIONS ?? '', /--add-opens=java\.base\/sun\.nio\.ch=ALL-UNNAMED/)
})
