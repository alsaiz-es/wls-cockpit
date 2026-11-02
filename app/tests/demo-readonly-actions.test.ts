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
