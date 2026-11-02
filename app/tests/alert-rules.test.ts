import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  ALERT_SUSTAIN_MAX_GAP_MS,
  AlertSustainTracker,
  DEFAULT_ALERT_RULES,
  DEFAULT_RESOLVED_ALERT_RULES,
  alertRulesConfigToFileShape,
  alertRulesExampleYaml,
  formatAlertDuration,
  isAlertIgnored,
  parseAlertDuration,
  resolveAlertRules,
  validateAlertRulesConfig,
} from '../src/api/alert-rules.ts'
import { buildServerPressureIssues, sustainedJdbcSeverity, sustainedJmsSeverity } from '../src/api/queries/dashboard-alert-levels.ts'
import { classifyDashboardJms } from '../src/api/queries/dashboard-jms-classification.ts'
import { AlertRulesStore, parseAlertRulesYaml } from '../server/alert-rules-store.ts'

const SECOND = 1_000

function server(threads: Partial<{ pending: number; hogging: number; stuck: number }>, heapPercent: number | null = 40) {
  return {
    name: 'AdminServer',
    heap: heapPercent === null ? null : { current: heapPercent, max: 100 },
    threads: { pending: 0, hogging: 0, stuck: 0, queueLength: 0, ...threads },
  }
}

function pressureIssues(tracker: AlertSustainTracker, servers: ReturnType<typeof server>[], now: number) {
  return buildServerPressureIssues(servers, { rules: DEFAULT_RESOLVED_ALERT_RULES, tracker, now }).map((issue) => [
    issue.id,
    issue.severity,
  ])
}

test('durations accept seconds, minutes, hours and bare seconds', () => {
  assert.equal(parseAlertDuration('30s'), 30_000)
  assert.equal(parseAlertDuration('2m'), 120_000)
  assert.equal(parseAlertDuration('1h'), 3_600_000)
  assert.equal(parseAlertDuration('500ms'), 500)
  assert.equal(parseAlertDuration(45), 45_000)
  assert.equal(parseAlertDuration('soon'), null)
  assert.equal(parseAlertDuration(-1), null)
  assert.equal(formatAlertDuration(0), 'immediately')
  assert.equal(formatAlertDuration(120_000), '2m')
  assert.equal(formatAlertDuration(30_000), '30s')
})

test('a short burst of pending requests and hogging threads raises nothing', () => {
  // The case seen right after an AdminServer start: pending 2 and hogging 2 for one reading.
  const tracker = new AlertSustainTracker()
  assert.deepEqual(pressureIssues(tracker, [server({ pending: 2, hogging: 2 })], 0), [])
  assert.deepEqual(pressureIssues(tracker, [server({ pending: 0, hogging: 0 })], 10 * SECOND), [])
})

test('pending requests warn and then turn critical only while they last', () => {
  const tracker = new AlertSustainTracker()
  const at = (seconds: number, pending: number) => pressureIssues(tracker, [server({ pending })], seconds * SECOND)
  assert.deepEqual(at(0, 25), [])
  assert.deepEqual(at(30, 25), [])
  assert.deepEqual(at(60, 25), [['threads:AdminServer', 'critical']])
  assert.deepEqual(at(70, 8), [['threads:AdminServer', 'warning']])
  assert.deepEqual(at(80, 0), [])
  assert.deepEqual(at(90, 8), [])
})

test('a stuck thread is critical at once and hogging alone is never critical', () => {
  const tracker = new AlertSustainTracker()
  assert.deepEqual(pressureIssues(tracker, [server({ stuck: 1 })], 0), [['threads:AdminServer', 'critical']])

  const hogging = new AlertSustainTracker()
  for (let seconds = 0; seconds < 120; seconds += 10) {
    assert.deepEqual(pressureIssues(hogging, [server({ hogging: 40 })], seconds * SECOND), [])
  }
  assert.deepEqual(pressureIssues(hogging, [server({ hogging: 40 })], 120 * SECOND), [['threads:AdminServer', 'warning']])
})

test('a gap in readings restarts the duration', () => {
  const tracker = new AlertSustainTracker()
  const rule = DEFAULT_ALERT_RULES['heap.percent']
  const resumedAt = rule.forMs - 10 * SECOND + ALERT_SUSTAIN_MAX_GAP_MS + SECOND
  for (let now = 0; now < rule.forMs; now += 10 * SECOND) assert.equal(tracker.level('heap', rule, 90, now), null)
  // The tab was hidden for over a minute: the earlier readings no longer count.
  assert.equal(tracker.level('heap', rule, 90, resumedAt), null)
  for (let now = resumedAt + 10 * SECOND; now < resumedAt + rule.forMs; now += 10 * SECOND) {
    assert.equal(tracker.level('heap', rule, 90, now), null)
  }
  assert.equal(tracker.level('heap', rule, 90, resumedAt + rule.forMs), 'warning')
})

test('heap pressure is a JVM issue after the rule duration', () => {
  const tracker = new AlertSustainTracker()
  assert.deepEqual(pressureIssues(tracker, [server({}, 97)], 0), [])
  for (let seconds = 10; seconds < 120; seconds += 10) pressureIssues(tracker, [server({}, 97)], seconds * SECOND)
  assert.deepEqual(pressureIssues(tracker, [server({}, 97)], 120 * SECOND), [['heap:AdminServer', 'critical']])
})

test('without a tracker each reading is judged on its own', () => {
  assert.deepEqual(
    buildServerPressureIssues([server({ pending: 6 })], { rules: DEFAULT_RESOLVED_ALERT_RULES, tracker: null, now: 0 }).map(
      (issue) => issue.severity,
    ),
    ['warning'],
  )
})

test('leaked connections alert on new leaks only', () => {
  const tracker = new AlertSustainTracker()
  const rule = DEFAULT_ALERT_RULES['jdbc.leaked']
  assert.equal(tracker.increaseLevel('pool', rule, 12, 0), null)
  assert.equal(tracker.increaseLevel('pool', rule, 12, 10 * SECOND), null)
  assert.equal(tracker.increaseLevel('pool', rule, 13, 20 * SECOND), 'warning')
  let now = 20 * SECOND
  while (now < 20 * SECOND + rule.forMs) {
    now += 10 * SECOND
    tracker.increaseLevel('pool', rule, 13, now)
  }
  assert.equal(tracker.increaseLevel('pool', rule, 13, now + 10 * SECOND), null)
})

test('JMS messages with consumers are normal traffic below the backlog threshold', () => {
  const destination = {
    destinationName: 'OrdersQueue',
    state: 'running',
    messagesCurrentCount: 40,
    messagesPendingCount: 3,
    consumersCurrentCount: 2,
    consumptionPaused: false,
    productionPaused: false,
    insertionPaused: false,
    consumptionPausedState: null,
    productionPausedState: null,
    insertionPausedState: null,
  }
  assert.equal(classifyDashboardJms(destination), 'healthy')
  assert.equal(classifyDashboardJms({ ...destination, messagesCurrentCount: 1_500 }), 'warning')
  assert.equal(classifyDashboardJms({ ...destination, consumersCurrentCount: 0 }), 'warning')

  const tracker = new AlertSustainTracker()
  const item = { ...destination, serverName: 'AdminServer', jmsServerName: 'JMSServer1', consumersCurrentCount: 0 }
  const context = (now: number) => ({ rules: DEFAULT_RESOLVED_ALERT_RULES, tracker, now })
  assert.equal(sustainedJmsSeverity(item, context(0)), 'healthy')
  for (let seconds = 10; seconds < 300; seconds += 10) sustainedJmsSeverity(item, context(seconds * SECOND))
  assert.equal(sustainedJmsSeverity(item, context(300 * SECOND)), 'warning')
  assert.equal(sustainedJmsSeverity({ ...item, consumptionPaused: true }, context(310 * SECOND)), 'critical')
})

test('pool usage without a readable maximum can warn but not be critical', () => {
  const pool = {
    serverName: 'AdminServer',
    name: 'OrdersDS',
    state: 'Running',
    deploymentState: 2,
    activeConnectionsCurrentCount: 5,
    currCapacity: 5,
    configuredMaxCapacity: null,
    waitingForConnectionCurrentCount: 0,
    leakedConnectionCount: 0,
    utilization: 1,
    utilizationCapacity: 5,
    utilizationCapacitySource: 'runtimeCurrent' as const,
    severity: 'healthy' as const,
  }
  assert.equal(sustainedJdbcSeverity(pool, { rules: DEFAULT_RESOLVED_ALERT_RULES, tracker: null, now: 0 }), 'warning')
  assert.equal(
    sustainedJdbcSeverity({ ...pool, utilizationCapacitySource: 'configuredMax' }, { rules: DEFAULT_RESOLVED_ALERT_RULES, tracker: null, now: 0 }),
    'critical',
  )
  assert.equal(sustainedJdbcSeverity({ ...pool, state: 'Overloaded', utilization: 0.1 }, { rules: DEFAULT_RESOLVED_ALERT_RULES, tracker: null, now: 0 }), 'critical')
})

test('validation keeps valid entries and reports the rest', () => {
  const { config, errors } = validateAlertRulesConfig({
    version: 1,
    rules: {
      'threads.pending': { warning: 10, for: '2m' },
      'threads.hogging': { enabled: false },
      'heap.percent': { warning: 95, critical: 90 },
      'threads.bogus': { warning: 1 },
      'jdbc.waiting': { warning: 'many', critical: null, colour: 'red' },
    },
    ignore: [{ jms: 'Demo!*' }, { queues: 'x' }, 'jms'],
    domains: { 'lab-1412': { rules: { 'heap.percent': { warning: 90 } }, ignore: [{ servers: 'server1' }] } },
    extra: true,
  })
  assert.deepEqual(config.rules['threads.pending'], { warning: 10, forMs: 120_000 })
  assert.deepEqual(config.rules['threads.hogging'], { enabled: false })
  assert.deepEqual(config.rules['heap.percent'], {})
  assert.deepEqual(config.rules['jdbc.waiting'], { critical: null })
  assert.deepEqual(config.ignore, [{ family: 'jms', pattern: 'Demo!*' }])
  assert.deepEqual(config.domains['lab-1412'].ignore, [{ family: 'servers', pattern: 'server1' }])
  assert.deepEqual(
    errors.map((error) => error.path.join('.')),
    [
      'rules.heap.percent',
      'rules.threads.bogus',
      'rules.jdbc.waiting.warning',
      'rules.jdbc.waiting.colour',
      'ignore.1',
      'ignore.2',
      'extra',
    ],
  )
})

test('domain overrides win over the file, which wins over the defaults', () => {
  const { config } = validateAlertRulesConfig({
    rules: { 'heap.percent': { warning: 80 }, 'jms.backlog': { critical: null } },
    ignore: [{ jms: 'Global*' }],
    domains: { 'lab-1412': { rules: { 'heap.percent': { warning: 90 } }, ignore: [{ jms: 'WLSCockpitDemoJMSModule!*' }] } },
  })
  const lab = resolveAlertRules(config, 'lab-1412')
  assert.equal(lab.rules['heap.percent'].warning, 90)
  assert.equal(lab.rules['heap.percent'].critical, 95)
  assert.equal(lab.rules['heap.percent'].source, 'domain')
  assert.equal(lab.rules['jms.backlog'].critical, null)
  assert.equal(lab.rules['jms.backlog'].source, 'file')
  assert.equal(lab.rules['threads.pending'].source, 'default')
  assert.equal(resolveAlertRules(validateAlertRulesConfig({ rules: { 'threads.pending': { warning: 'lots' } } }).config, null).rules['threads.pending'].source, 'default')
  assert.deepEqual(lab.ignore.map((rule) => [rule.pattern, rule.source]), [['Global*', 'file'], ['WLSCockpitDemoJMSModule!*', 'domain']])
  assert.equal(resolveAlertRules(config, 'other').rules['heap.percent'].warning, 80)

  assert.equal(isAlertIgnored(lab, 'jms', 'WLSCockpitDemoJMSModule!WLSCockpitDemoQueue'), true)
  assert.equal(isAlertIgnored(lab, 'jms', 'OrdersModule!OrdersQueue'), false)
  assert.equal(isAlertIgnored(lab, 'jdbc', 'WLSCockpitDemoJMSModule!WLSCockpitDemoQueue'), false)
})

test('the example file is valid and matches the defaults', () => {
  const { config, errors } = parseAlertRulesYaml(alertRulesExampleYaml())
  assert.deepEqual(errors, [])
  const resolved = resolveAlertRules(config, null)
  for (const [id, rule] of Object.entries(DEFAULT_ALERT_RULES)) {
    const effective = resolved.rules[id as keyof typeof DEFAULT_ALERT_RULES]
    assert.deepEqual({ enabled: effective.enabled, warning: effective.warning, critical: effective.critical, forMs: effective.forMs }, rule, id)
  }
})

test('YAML errors point at their line', () => {
  const invalid = parseAlertRulesYaml(['version: 1', 'rules:', '  threads.pending:', '    warning: lots', '    for: 30s', ''].join('\n'))
  assert.deepEqual(invalid.errors.map((error) => [error.line, error.path.join('.')]), [[4, 'rules.threads.pending.warning']])
  assert.equal(invalid.config.rules['threads.pending']?.forMs, 30_000)

  const broken = parseAlertRulesYaml('rules:\n  threads.pending: { warning: 5\n')
  assert.equal(broken.errors.length > 0, true)
  assert.equal(typeof broken.errors[0].line, 'number')
  assert.deepEqual(broken.config.rules, {})
})

test('the store reads alerts.yaml again when it changes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wls-cockpit-alerts-'))
  try {
    const store = new AlertRulesStore({ dataDir: dir })
    const missing = await store.read()
    assert.equal(missing.exists, false)
    assert.equal(missing.path, path.join(dir, 'alerts.yaml'))

    await writeFile(path.join(dir, 'alerts.yaml'), 'rules:\n  heap.percent: { warning: 90 }\n')
    assert.equal((await store.read()).config.rules['heap.percent']?.warning, 90)

    await writeFile(path.join(dir, 'alerts.yaml'), 'rules:\n  heap.percent: { warning: 75, for: 5m }\n')
    const changed = await store.read()
    assert.equal(changed.config.rules['heap.percent']?.warning, 75)
    assert.equal(changed.config.rules['heap.percent']?.forMs, 300_000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the config the server sends validates again in the browser unchanged', () => {
  const { config } = parseAlertRulesYaml(
    [
      'rules:',
      '  heap.percent: { warning: 90, for: 3m }',
      'ignore:',
      '  - jdbc: "LegacyDS*"',
      'domains:',
      '  Lab 14.1.2:',
      '    rules:',
      '      jms.noConsumers: { for: 20s, critical: null }',
      '    ignore:',
      '      - jms: "Demo!*"',
      '',
    ].join('\n'),
  )
  const sent = JSON.parse(JSON.stringify(config))
  const again = validateAlertRulesConfig(alertRulesConfigToFileShape(sent))
  assert.deepEqual(again.errors, [])
  assert.deepEqual(again.config, config)
})
