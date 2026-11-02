import assert from 'node:assert/strict'
import test from 'node:test'

const smoke = await import('../scripts/visual-smoke.mjs')

test('visual smoke defaults to read-only registered checks', () => {
  const selection = smoke.selectSmokeChecks()

  assert.equal(selection.profile, 'readonly')
  assert.ok(selection.checks.length > 0)
  assert.ok(selection.checks.every((check) => check.profile === 'readonly'))
  assert.ok(selection.skipped.includes('servers-lifecycle'))
  assert.ok(selection.skipped.includes('deployments-lifecycle'))
  assert.ok(selection.skipped.includes('data-sources-lifecycle'))
  assert.ok(selection.skipped.includes('demo-readonly-live'))
  assert.ok(selection.skipped.includes('edit-session-readonly-status'))
  assert.ok(selection.skipped.includes('edit-session-disposable'))
  assert.ok(selection.skipped.includes('jms-message-roundtrip'))
  assert.ok(selection.skipped.includes('topology-config-disposable-preflight'))
  assert.ok(selection.skipped.includes('topology-config-disposable-mutations'))
  assert.ok(selection.skipped.includes('jndi-safe-binding-live'))
})

test('visual smoke registers server metrics fixtures and live route as read-only', () => {
  const fixtureChecks = smoke.SMOKE_CHECK_REGISTRY.filter((check) => check.name.startsWith('server-metrics-fixture-'))
  assert.deepEqual(
    fixtureChecks.map((check) => check.name),
    [
      'server-metrics-fixture-active',
      'server-metrics-fixture-stopped',
      'server-metrics-fixture-unavailable',
      'server-metrics-fixture-gap',
    ],
  )
  assert.ok(fixtureChecks.every((check) => check.profile === 'readonly'))
  assert.ok(fixtureChecks.every((check) => check.mutations === undefined))

  const live = smoke.SMOKE_CHECK_REGISTRY.find((check) => check.name === 'server-metrics-live')
  assert.ok(live)
  assert.equal(live.profile, 'readonly')
  assert.equal(live.mutations, undefined)
})

test('visual smoke registers diagnostic snapshot export as targeted read-only', () => {
  const check = smoke.SMOKE_CHECK_REGISTRY.find((candidate) => candidate.name === 'diagnostic-snapshot-live')

  assert.ok(check)
  assert.equal(check.profile, 'readonly')
  assert.equal(check.mode, 'helper')
  assert.equal(check.defaultEnabled, false)
  assert.deepEqual(check.readActions, [{ method: 'POST', includes: ['/WLDFDataAccessRuntimes/', '/search'] }])
  assert.equal(check.mutations, undefined)
})

test('visual smoke registers domain config snapshots as targeted read-only', () => {
  const check = smoke.SMOKE_CHECK_REGISTRY.find((candidate) => candidate.name === 'domain-config-snapshots-live')

  assert.ok(check)
  assert.equal(check.profile, 'readonly')
  assert.equal(check.mode, 'helper')
  assert.equal(check.defaultEnabled, false)
  assert.equal(check.readActions, undefined)
  assert.equal(check.mutations, undefined)
})

test('visual smoke targeted checks cannot cross profiles', () => {
  assert.throws(
    () => smoke.selectSmokeChecks({ profile: 'readonly', checkFilter: 'servers-lifecycle' }),
    /belongs to WLS_SMOKE_PROFILE=lifecycle/,
  )
  assert.throws(
    () => smoke.selectSmokeChecks({ profile: 'readonly', checkFilter: 'jms-message-roundtrip' }),
    /belongs to WLS_SMOKE_PROFILE=jms-mutation/,
  )
  assert.throws(
    () => smoke.selectSmokeChecks({ profile: 'readonly', checkFilter: 'unknown-check' }),
    /Unknown WLS_SMOKE_CHECKS: unknown-check/,
  )
  assert.throws(
    () => smoke.selectSmokeChecks({ profile: 'destructive' }),
    /Unsupported WLS_SMOKE_PROFILE=destructive/,
  )
})

test('visual smoke JMS mutation check is explicit and targeted', () => {
  const check = smoke.SMOKE_CHECK_REGISTRY.find((candidate) => candidate.name === 'jms-message-roundtrip')
  assert.ok(check)
  assert.equal(check.profile, 'jms-mutation')
  assert.equal(check.mode, 'helper')
  assert.equal(check.defaultEnabled, false)
  assert.deepEqual(check.mutations, [
    { method: 'POST', includes: ['/api/jms/messages/produce'] },
    { method: 'POST', includes: ['/api/jms/messages/delete'] },
    { method: 'POST', includes: ['/JMSRuntime/JMSServers/', '/destinations/', '/pauseConsumption'] },
    { method: 'POST', includes: ['/JMSRuntime/JMSServers/', '/destinations/', '/pauseInsertion'] },
    { method: 'POST', includes: ['/JMSRuntime/JMSServers/', '/destinations/', '/pauseProduction'] },
    { method: 'POST', includes: ['/JMSRuntime/JMSServers/', '/destinations/', '/resumeConsumption'] },
    { method: 'POST', includes: ['/JMSRuntime/JMSServers/', '/destinations/', '/resumeInsertion'] },
    { method: 'POST', includes: ['/JMSRuntime/JMSServers/', '/destinations/', '/resumeProduction'] },
  ])

  const selection = smoke.selectSmokeChecks({
    profile: 'jms-mutation',
    checkFilter: 'jms-message-roundtrip',
  })

  assert.deepEqual(selection.checks.map((candidate) => candidate.name), ['jms-message-roundtrip'])
})

test('visual smoke targeted read-only checks keep registry order', () => {
  const selection = smoke.selectSmokeChecks({
    profile: 'readonly',
    checkFilter: 'log-details-live,dashboard-fixture-healthy,logs-live',
  })

  assert.deepEqual(
    selection.checks.map((check) => check.name),
    ['dashboard-fixture-healthy', 'logs-live', 'log-details-live'],
  )
})

test('visual smoke demo read-only check is targeted and read-only', () => {
  const selection = smoke.selectSmokeChecks({
    profile: 'readonly',
    checkFilter: 'demo-readonly-live',
  })

  assert.deepEqual(selection.checks.map((check) => check.name), ['demo-readonly-live'])
  assert.equal(selection.checks[0].profile, 'readonly')
  assert.equal(selection.checks[0].defaultEnabled, false)
})

test('visual smoke edit-session checks are explicit and profile-scoped', () => {
  const readonlySelection = smoke.selectSmokeChecks({
    profile: 'readonly',
    checkFilter: 'edit-session-readonly-status',
  })
  assert.deepEqual(readonlySelection.checks.map((check) => check.name), ['edit-session-readonly-status'])
  assert.equal(readonlySelection.checks[0].profile, 'readonly')
  assert.equal(readonlySelection.checks[0].defaultEnabled, false)

  const lifecycleSelection = smoke.selectSmokeChecks({
    profile: 'lifecycle',
    checkFilter: 'edit-session-disposable',
  })
  assert.deepEqual(lifecycleSelection.checks.map((check) => check.name), ['edit-session-disposable'])
  assert.equal(lifecycleSelection.checks[0].profile, 'lifecycle')
  assert.deepEqual(lifecycleSelection.checks[0].mutations, [
    { method: 'POST', includes: ['/edit/changeManager/startEdit'] },
    { method: 'POST', includes: ['/edit/changeManager/cancelEdit'] },
  ])
})


test('visual smoke compatibility checks are read-only and selectable', () => {
  const compatChecks = smoke.SMOKE_CHECK_REGISTRY.filter((check) => check.mode === 'compat')

  assert.deepEqual(
    compatChecks.map((check) => check.name),
    [
      'compat-dashboard-live',
      'compat-servers-live',
      'compat-server-details-admin',
      'compat-clusters-live',
      'compat-node-manager-live',
      'compat-deployments-live',
      'compat-data-sources-live',
      'compat-jms-live',
      'compat-logs-live',
      'compat-log-details-admin',
    ],
  )
  assert.ok(compatChecks.every((check) => check.profile === 'readonly'))
  assert.ok(compatChecks.every((check) => check.mutations === undefined))
  assert.ok(compatChecks.every((check) => !check.name.includes('WLSCockpitDemo')))
  assert.equal(compatChecks.find((check) => check.name === 'compat-servers-live')?.assertFailedNotRestartableStart, true)
})

test('visual smoke reports missing failed-not-restartable start affordances without requiring a row', () => {
  assert.deepEqual(
    smoke.failedNotRestartableStartAffordanceIssues([
      {
        text: 'AdminServer RUNNING',
        buttons: [],
      },
    ]),
    [],
  )
  assert.deepEqual(
    smoke.failedNotRestartableStartAffordanceIssues([
      {
        text: 'osb_server1 FAILED_NOT_RESTARTABLE',
        buttons: [{ text: 'Start', disabled: false }],
      },
    ]),
    [],
  )
  assert.deepEqual(
    smoke.failedNotRestartableStartAffordanceIssues([
      {
        text: 'osb_server1 FAILED_NOT_RESTARTABLE',
        buttons: [],
      },
      {
        text: 'osb_server2 FAILED_NOT_RESTARTABLE',
        buttons: [{ text: 'Start', disabled: true }],
      },
    ]),
    [
      'osb_server1 FAILED_NOT_RESTARTABLE: Start action missing',
      'osb_server2 FAILED_NOT_RESTARTABLE: Start action disabled',
    ],
  )
})

test('visual smoke registers targeted JMS URL-state check as read-only', () => {
  const check = smoke.SMOKE_CHECK_REGISTRY.find((candidate) => candidate.name === 'jms-url-state-return')
  assert.ok(check)
  assert.equal(check.profile, 'readonly')
  assert.equal(check.mode, 'url-state')
  assert.equal(check.defaultEnabled, false)
  assert.equal(check.mutations, undefined)

  const selection = smoke.selectSmokeChecks({
    profile: 'readonly',
    checkFilter: 'jms-url-state-return',
  })

  assert.deepEqual(selection.checks.map((candidate) => candidate.name), ['jms-url-state-return'])
})

test('visual smoke JNDI safe binding check is targeted and read-only', () => {
  const check = smoke.SMOKE_CHECK_REGISTRY.find((candidate) => candidate.name === 'jndi-safe-binding-live')
  assert.ok(check)
  assert.equal(check.profile, 'readonly')
  assert.equal(check.mode, 'helper')
  assert.equal(check.defaultEnabled, false)
  assert.equal(check.mutations, undefined)
  assert.equal(check.readActions, undefined)

  const selection = smoke.selectSmokeChecks({
    profile: 'readonly',
    checkFilter: 'jndi-safe-binding-live',
  })

  assert.deepEqual(selection.checks.map((candidate) => candidate.name), ['jndi-safe-binding-live'])
})

test('visual smoke JTA route check is read-only', () => {
  const check = smoke.SMOKE_CHECK_REGISTRY.find((candidate) => candidate.name === 'jta-live')
  assert.ok(check)
  assert.equal(check.profile, 'readonly')
  assert.equal(check.mode, 'route')
  assert.equal(check.mutations, undefined)

  const selection = smoke.selectSmokeChecks({
    profile: 'readonly',
    checkFilter: 'jta-live',
  })

  assert.deepEqual(selection.checks.map((candidate) => candidate.name), ['jta-live'])
})

test('visual smoke deployment matrix check is read-only', () => {
  const check = smoke.SMOKE_CHECK_REGISTRY.find((candidate) => candidate.name === 'deployment-targeting-matrix-live')
  assert.ok(check)
  assert.equal(check.profile, 'readonly')
  assert.equal(check.mode, 'helper')
  assert.equal(check.mutations, undefined)

  const selection = smoke.selectSmokeChecks({
    profile: 'readonly',
    checkFilter: 'deployment-targeting-matrix-live',
  })
  assert.deepEqual(selection.checks.map((candidate) => candidate.name), ['deployment-targeting-matrix-live'])
})

test('visual smoke deployment request metrics check is targeted and read-only', () => {
  const check = smoke.SMOKE_CHECK_REGISTRY.find((candidate) => candidate.name === 'deployment-request-metrics-live')
  assert.ok(check)
  assert.equal(check.profile, 'readonly')
  assert.equal(check.mode, 'helper')
  assert.equal(check.defaultEnabled, false)
  assert.equal(check.mutations, undefined)
  assert.deepEqual(check.readActions, [{ method: 'POST', includes: ['/domainRuntime/getServerHttpURL'] }])

  const selection = smoke.selectSmokeChecks({
    profile: 'readonly',
    checkFilter: 'deployment-request-metrics-live',
  })
  assert.deepEqual(selection.checks.map((candidate) => candidate.name), ['deployment-request-metrics-live'])
})

test('visual smoke Work Managers check is default read-only coverage', () => {
  const check = smoke.SMOKE_CHECK_REGISTRY.find((candidate) => candidate.name === 'work-managers-live')
  assert.ok(check)
  assert.equal(check.profile, 'readonly')
  assert.equal(check.mode, 'helper')
  assert.equal(check.defaultEnabled, undefined)
  assert.equal(check.mutations, undefined)

  const selection = smoke.selectSmokeChecks({
    profile: 'readonly',
    checkFilter: 'work-managers-live',
  })
  assert.deepEqual(selection.checks.map((candidate) => candidate.name), ['work-managers-live'])
})

test('visual smoke theme mode coverage is targeted and read-only', () => {
  const check = smoke.SMOKE_CHECK_REGISTRY.find((candidate) => candidate.name === 'theme-mode-coverage-live')
  assert.ok(check)
  assert.equal(check.profile, 'readonly')
  assert.equal(check.mode, 'helper')
  assert.equal(check.defaultEnabled, false)
  assert.equal(check.mutations, undefined)
  assert.equal(check.readActions, undefined)

  const selection = smoke.selectSmokeChecks({
    profile: 'readonly',
    checkFilter: 'theme-mode-coverage-live',
  })
  assert.deepEqual(selection.checks.map((candidate) => candidate.name), ['theme-mode-coverage-live'])
})

test('visual smoke Node Manager configuration editor check is explicit and read-only', () => {
  const check = smoke.SMOKE_CHECK_REGISTRY.find((candidate) => candidate.name === 'node-manager-config-editor-live')
  assert.ok(check)
  assert.equal(check.profile, 'readonly')
  assert.equal(check.mode, 'helper')
  assert.equal(check.defaultEnabled, false)
  assert.equal(check.mutations, undefined)

  const selection = smoke.selectSmokeChecks({
    profile: 'readonly',
    checkFilter: 'node-manager-config-editor-live',
  })
  assert.deepEqual(selection.checks.map((candidate) => candidate.name), ['node-manager-config-editor-live'])
})

test('visual smoke topology configuration checks are profile-safe', () => {
  const serverReadonly = smoke.SMOKE_CHECK_REGISTRY.find((candidate) => candidate.name === 'topology-server-config-readonly')
  const clustersReadonly = smoke.SMOKE_CHECK_REGISTRY.find((candidate) => candidate.name === 'topology-clusters-config-readonly')
  const preflight = smoke.SMOKE_CHECK_REGISTRY.find((candidate) => candidate.name === 'topology-config-disposable-preflight')
  const mutations = smoke.SMOKE_CHECK_REGISTRY.find((candidate) => candidate.name === 'topology-config-disposable-mutations')

  assert.ok(serverReadonly)
  assert.equal(serverReadonly.profile, 'readonly')
  assert.equal(serverReadonly.defaultEnabled, false)
  assert.equal(serverReadonly.mutations, undefined)
  assert.ok(clustersReadonly)
  assert.equal(clustersReadonly.profile, 'readonly')
  assert.equal(clustersReadonly.defaultEnabled, false)
  assert.equal(clustersReadonly.mutations, undefined)

  assert.ok(preflight)
  assert.equal(preflight.profile, 'topology-config')
  assert.equal(preflight.defaultEnabled, false)
  assert.deepEqual(preflight.readActions, [
    { method: 'GET', includes: ['/edit/servers'] },
    { method: 'GET', includes: ['/edit/clusters'] },
  ])
  assert.equal(preflight.mutations, undefined)

  assert.ok(mutations)
  assert.equal(mutations.profile, 'topology-config')
  assert.equal(mutations.defaultEnabled, false)
  assert.deepEqual(mutations.readActions, [
    { method: 'GET', includes: ['/edit/servers'] },
    { method: 'GET', includes: ['/edit/clusters'] },
  ])
  assert.deepEqual(mutations.mutations, [
    { method: 'POST', includes: ['/edit/changeManager/startEdit'] },
    { method: 'POST', includes: ['/edit/changeManager/activate'] },
    { method: 'POST', includes: ['/edit/changeManager/cancelEdit'] },
    { method: 'POST', includes: ['/edit/servers'] },
    { method: 'POST', includes: ['/edit/clusters'] },
    { method: 'DELETE', includes: ['/edit/servers/'] },
    { method: 'DELETE', includes: ['/edit/clusters/'] },
  ])

  assert.throws(
    () => smoke.selectSmokeChecks({ profile: 'readonly', checkFilter: 'topology-config-disposable-preflight' }),
    /belongs to WLS_SMOKE_PROFILE=topology-config/,
  )
  assert.throws(
    () => smoke.selectSmokeChecks({ profile: 'readonly', checkFilter: 'topology-config-disposable-mutations' }),
    /belongs to WLS_SMOKE_PROFILE=topology-config/,
  )
  const selection = smoke.selectSmokeChecks({
    profile: 'topology-config',
    checkFilter: 'topology-config-disposable-preflight,topology-config-disposable-mutations',
  })
  assert.deepEqual(selection.checks.map((candidate) => candidate.name), [
    'topology-config-disposable-preflight',
    'topology-config-disposable-mutations',
  ])
})

test('visual smoke registers targeted log archive tail selection as read-only', () => {
  const check = smoke.SMOKE_CHECK_REGISTRY.find((candidate) => candidate.name === 'log-archive-tail-selection-live')
  assert.ok(check)
  assert.equal(check.profile, 'readonly')
  assert.equal(check.mode, 'helper')
  assert.equal(check.defaultEnabled, false)
  assert.equal(check.mutations, undefined)
  assert.deepEqual(check.readActions, [{ method: 'POST', includes: ['/WLDFDataAccessRuntimes/', '/search'] }])

  const selection = smoke.selectSmokeChecks({
    profile: 'readonly',
    checkFilter: 'log-archive-tail-selection-live',
  })

  assert.deepEqual(selection.checks.map((candidate) => candidate.name), ['log-archive-tail-selection-live'])
})

test('visual smoke registers multi-server log tail as read-only', () => {
  const check = smoke.SMOKE_CHECK_REGISTRY.find((candidate) => candidate.name === 'multiserver-log-tail-live')
  assert.ok(check)
  assert.equal(check.profile, 'readonly')
  assert.equal(check.mode, 'helper')
  assert.equal(check.defaultEnabled, false)
  assert.equal(check.mutations, undefined)
  assert.deepEqual(check.readActions, [{ method: 'POST', includes: ['/WLDFDataAccessRuntimes/', '/search'] }])

  const selection = smoke.selectSmokeChecks({
    profile: 'readonly',
    checkFilter: 'multiserver-log-tail-live',
  })

  assert.deepEqual(selection.checks.map((candidate) => candidate.name), ['multiserver-log-tail-live'])
})

test('visual smoke targeted compatibility checks keep registry order', () => {
  const selection = smoke.selectSmokeChecks({
    profile: 'readonly',
    checkFilter: 'compat-log-details-admin,compat-dashboard-live,compat-data-sources-live',
  })

  assert.deepEqual(
    selection.checks.map((check) => check.name),
    ['compat-dashboard-live', 'compat-data-sources-live', 'compat-log-details-admin'],
  )
})

test('visual smoke compatibility checks cannot run under lifecycle profile', () => {
  assert.throws(
    () => smoke.selectSmokeChecks({ profile: 'lifecycle', checkFilter: 'compat-dashboard-live' }),
    /belongs to WLS_SMOKE_PROFILE=readonly/,
  )
})

test('visual smoke audit blocks undeclared read-only mutations and allows declared read actions', () => {
  const check = smoke.SMOKE_CHECK_REGISTRY.find((candidate) => candidate.name === 'log-details-live')
  assert.ok(check)

  assert.doesNotThrow(() =>
    smoke.auditSmokeRequest({
      profile: 'readonly',
      check,
      method: 'POST',
      path: '/api/wls/management/weblogic/14.1.2.0.0/domainRuntime/serverRuntimes/AdminServer/WLDFRuntime/WLDFAccessRuntime/WLDFDataAccessRuntimes/ServerLog/search',
    }),
  )

  assert.throws(
    () =>
      smoke.auditSmokeRequest({
        profile: 'readonly',
        check,
        method: 'POST',
        path: '/api/wls/management/weblogic/14.1.2.0.0/domainRuntime/serverLifeCycleRuntimes/server1/start',
      }),
    /blocked undeclared read-only request/,
  )

  assert.throws(
    () =>
      smoke.auditSmokeRequest({
        profile: 'readonly',
        check,
        method: 'POST',
        path: '/api/wls/management/weblogic/14.1.2.0.0/domainRuntime/serverRuntimes/AdminServer/JTARuntime/forceCommit',
      }),
    /blocked JTA recovery request/,
  )
  assert.throws(
    () =>
      smoke.auditSmokeRequest({
        profile: 'readonly',
        check,
        method: 'POST',
        path: '/api/wls/management/weblogic/14.1.2.0.0/edit/machines/machine1/nodeManager',
      }),
    /blocked edit-tree request/,
  )
})

test('visual smoke audit allows only declared lifecycle mutations', () => {
  const check = smoke.SMOKE_CHECK_REGISTRY.find((candidate) => candidate.name === 'servers-lifecycle')
  assert.ok(check)

  assert.doesNotThrow(() =>
    smoke.auditSmokeRequest({
      profile: 'lifecycle',
      check,
      method: 'POST',
      path: '/api/wls/management/weblogic/14.1.2.0.0/domainRuntime/serverLifeCycleRuntimes/server1/start',
    }),
  )
  assert.doesNotThrow(() =>
    smoke.auditSmokeRequest({
      profile: 'lifecycle',
      check: smoke.SMOKE_CHECK_REGISTRY.find((candidate) => candidate.name === 'edit-session-disposable'),
      method: 'POST',
      path: '/api/wls/management/weblogic/14.1.2.0.0/edit/changeManager/startEdit',
    }),
  )

  assert.throws(
    () =>
      smoke.auditSmokeRequest({
        profile: 'lifecycle',
        check,
        method: 'POST',
        path: '/api/wls/management/weblogic/14.1.2.0.0/edit/changeManager/startEdit',
      }),
    /blocked edit-tree request/,
  )
})

test('visual smoke audit allows only declared JMS mutation requests', () => {
  const check = smoke.SMOKE_CHECK_REGISTRY.find((candidate) => candidate.name === 'jms-message-roundtrip')
  assert.ok(check)

  assert.doesNotThrow(() =>
    smoke.auditSmokeRequest({
      profile: 'jms-mutation',
      check,
      method: 'POST',
      path: '/api/jms/messages/produce',
    }),
  )
  assert.doesNotThrow(() =>
    smoke.auditSmokeRequest({
      profile: 'jms-mutation',
      check,
      method: 'POST',
      path: '/api/jms/messages/delete',
    }),
  )
  assert.doesNotThrow(() =>
    smoke.auditSmokeRequest({
      profile: 'jms-mutation',
      check,
      method: 'POST',
      path: '/api/wls/management/weblogic/14.1.2.0.0/domainRuntime/serverRuntimes/AdminServer/JMSRuntime/JMSServers/DemoJMSServer/destinations/DemoQueue/pauseProduction',
    }),
  )
  assert.doesNotThrow(() =>
    smoke.auditSmokeRequest({
      profile: 'jms-mutation',
      check,
      method: 'POST',
      path: '/api/wls/management/weblogic/14.1.2.0.0/domainRuntime/serverRuntimes/AdminServer/JMSRuntime/JMSServers/DemoJMSServer/destinations/DemoQueue/resumeProduction',
    }),
  )
  assert.throws(
    () =>
      smoke.auditSmokeRequest({
        profile: 'jms-mutation',
        check,
        method: 'POST',
        path: '/api/wls/management/weblogic/14.1.2.0.0/domainRuntime/serverLifeCycleRuntimes/server1/start',
      }),
    /blocked undeclared JMS mutation request/,
  )
})

test('visual smoke audit allows only declared topology configuration requests', () => {
  const preflight = smoke.SMOKE_CHECK_REGISTRY.find((candidate) => candidate.name === 'topology-config-disposable-preflight')
  const check = smoke.SMOKE_CHECK_REGISTRY.find((candidate) => candidate.name === 'topology-config-disposable-mutations')
  assert.ok(preflight)
  assert.ok(check)

  assert.doesNotThrow(() =>
    smoke.auditSmokeRequest({
      profile: 'topology-config',
      check: preflight,
      method: 'GET',
      path: '/api/wls/management/weblogic/14.1.2.0.0/edit/servers?fields=name&links=none',
    }),
  )
  assert.throws(
    () =>
      smoke.auditSmokeRequest({
        profile: 'topology-config',
        check: preflight,
        method: 'POST',
        path: '/api/wls/management/weblogic/14.1.2.0.0/edit/servers',
      }),
    /blocked edit-tree request/,
  )
  assert.doesNotThrow(() =>
    smoke.auditSmokeRequest({
      profile: 'topology-config',
      check,
      method: 'POST',
      path: '/api/wls/management/weblogic/14.1.2.0.0/edit/servers',
    }),
  )
  assert.doesNotThrow(() =>
    smoke.auditSmokeRequest({
      profile: 'topology-config',
      check,
      method: 'DELETE',
      path: '/api/wls/management/weblogic/14.1.2.0.0/edit/clusters/WLSCockpitSmokeCluster',
    }),
  )
  assert.throws(
    () =>
      smoke.auditSmokeRequest({
        profile: 'topology-config',
        check,
        method: 'POST',
        path: '/api/wls/management/weblogic/14.1.2.0.0/domainRuntime/serverLifeCycleRuntimes/server1/start',
      }),
    /blocked undeclared topology configuration request/,
  )
})
