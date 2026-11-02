import assert from 'node:assert/strict'
import test from 'node:test'
import {
  availableDeploymentLifecycleActions,
  canMutateDeploymentConfig,
} from '../src/routes/deployment-actions.ts'
import {
  canMutateDataSourceConfig,
  dataSourceRowActions,
} from '../src/routes/data-source-actions.ts'
import { demoSensitiveValue } from '../src/routes/demo-readonly-values.ts'

test('deployment actions remain available in normal mode and hidden in demo read-only mode', () => {
  const activeExternal = {
    scope: 'external' as const,
    lifecycleSupported: true,
    configurationSupported: true,
    deploymentState: 'ACTIVE',
    activeVersionState: null,
  }

  assert.deepEqual(availableDeploymentLifecycleActions(activeExternal), ['stop', 'redeploy'])
  assert.equal(canMutateDeploymentConfig(activeExternal), true)
  assert.deepEqual(availableDeploymentLifecycleActions(activeExternal, { readOnlyDemoMode: true }), [])
  assert.equal(canMutateDeploymentConfig(activeExternal, { readOnlyDemoMode: true }), false)
})

test('datasource actions remain available in normal mode and hidden in demo read-only mode', () => {
  const running = {
    state: 'Running',
    runtimeAvailable: true,
    configurationSupported: true,
    systemResourceName: 'OrdersDS',
  }

  assert.deepEqual(dataSourceRowActions(running), ['testPool', 'suspend', 'shrink', 'reset', 'clearStatementCache'])
  assert.equal(canMutateDataSourceConfig(running), true)
  assert.deepEqual(dataSourceRowActions(running, { readOnlyDemoMode: true }), [])
  assert.equal(canMutateDataSourceConfig(running, { readOnlyDemoMode: true }), false)

  const configuredOnly = { ...running, runtimeAvailable: false, state: 'Runtime not reported' }
  assert.deepEqual(dataSourceRowActions(configuredOnly), [])
  assert.equal(canMutateDataSourceConfig(configuredOnly), true)
})

test('demo mode masks sensitive display values without changing empty values', () => {
  assert.equal(demoSensitiveValue('/u01/domains/app.war', true), 'Hidden in demo mode')
  assert.equal(demoSensitiveValue('jdbc:oracle:thin:@example', true), 'Hidden in demo mode')
  assert.equal(demoSensitiveValue('', true), '')
  assert.equal(demoSensitiveValue(null, true), null)
  assert.equal(demoSensitiveValue('/u01/domains/app.war', false), '/u01/domains/app.war')
})

test('demo mode drops JMS message bodies on the server', async () => {
  const { maskJmsPayloadForDemo, JMS_DEMO_BODY_HIDDEN_REASON } = await import('../server/jms-jmx-contract.ts')
  const masked = maskJmsPayloadForDemo({
    message: { messageId: 'ID:1', bodyText: 'card=4111…', messageXmlText: '<mes:WLJMSMessage>…', bodyUnavailableReason: null },
  }) as { message: Record<string, unknown> }
  assert.equal(masked.message.messageId, 'ID:1')
  assert.equal(masked.message.bodyText, null)
  assert.equal(masked.message.messageXmlText, null)
  assert.equal(masked.message.bodyUnavailableReason, JMS_DEMO_BODY_HIDDEN_REASON)
  assert.equal(maskJmsPayloadForDemo(null), null)
})

test('clearing a user lockout is offered in normal mode and removed in demo read-only mode', async () => {
  const { lockoutClearServers } = await import('../src/routes/security-model.ts')
  const row = (serverName: string, available: boolean) => ({
    serverName,
    lifecycleState: available ? ('RUNNING' as const) : ('SHUTDOWN' as const),
    available,
    error: null,
    lockedUsersCurrentCount: available ? 1 : null,
    userLockoutTotalCount: null,
    invalidLoginAttemptsTotalCount: null,
    invalidLoginUsersHighCount: null,
    loginAttemptsWhileLockedTotalCount: null,
    unlockedUsersTotalCount: null,
  })
  const rows = [row('AdminServer', true), row('server1', false)]

  assert.deepEqual(lockoutClearServers(rows), ['AdminServer'])
  assert.deepEqual(lockoutClearServers(rows, { readOnlyDemoMode: true }), [])
})

test('debug flag changes are offered in normal mode and removed in demo read-only mode', async () => {
  const { debugFlagsEditable } = await import('../src/routes/server-debug-model.ts')
  const snapshot = { flags: { debugJDBCSQL: false } }
  assert.equal(debugFlagsEditable(snapshot), true)
  assert.equal(debugFlagsEditable(snapshot, { readOnlyDemoMode: true }), false)
})

test('alert rule editing is offered in normal mode and removed in demo read-only mode', async () => {
  const { canEditAlertRules } = await import('../src/routes/alert-rules-editor-model.ts')
  const file = { available: true, exists: true, revision: '1-10', errors: [] }
  assert.equal(canEditAlertRules(file), true)
  assert.equal(canEditAlertRules(file, { readOnlyDemoMode: true }), false)
  assert.equal(canEditAlertRules({ ...file, errors: [{ path: [] }] }), false)
  assert.equal(canEditAlertRules({ ...file, errors: [{ path: ['rules', 'heap.percent', 'warning'] }] }), true)
  assert.equal(canEditAlertRules({ ...file, available: false }), false)

  const { handleAlertRulesRequest } = await import('../server/http.ts')
  const { Readable } = await import('node:stream')
  const req = Object.assign(Readable.from([Buffer.from('{"revision":"none","config":{}}')]), {
    method: 'PUT',
    url: '/__wls-cockpit/alert-rules',
    headers: { host: '127.0.0.1:8888', 'content-type': 'application/json' },
  })
  let status = 0
  let body = ''
  const res = {
    statusCode: 0,
    setHeader() {},
    end(chunk?: string) {
      status = this.statusCode
      body = chunk ?? ''
    },
  }
  await handleAlertRulesRequest(req as never, res as never, { defaultVersion: '14.1.2.0.0', readOnlyDemoMode: true })
  assert.equal(status, 403)
  assert.match(body, /read-only demo mode/)
})
