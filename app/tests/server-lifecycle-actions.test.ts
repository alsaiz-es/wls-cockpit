import assert from 'node:assert/strict'
import test from 'node:test'
import {
  actionLabel,
  batchLifecycleAction,
  isDestructiveServerLifecycleAction,
  pendingLabel,
  rowLifecycleActions,
} from '../src/routes/server-lifecycle-actions.ts'

test('row lifecycle actions include suspend and resume without exposing AdminServer', () => {
  assert.deepEqual(rowLifecycleActions({ name: 'server1', state: 'SHUTDOWN' }), ['start'])
  assert.deepEqual(rowLifecycleActions({ name: 'server1', state: 'FAILED_NOT_RESTARTABLE' }), ['start'])
  assert.deepEqual(rowLifecycleActions({ name: 'server1', state: 'RUNNING' }), ['suspend', 'shutdown', 'forceShutdown'])
  assert.deepEqual(rowLifecycleActions({ name: 'server1', state: 'SUSPENDED' }), ['resume', 'shutdown', 'forceShutdown'])
  assert.deepEqual(rowLifecycleActions({ name: 'server1', state: 'ADMIN' }), ['resume', 'shutdown', 'forceShutdown'])
  assert.deepEqual(rowLifecycleActions({ name: 'server1', state: 'STANDBY' }), ['resume', 'shutdown', 'forceShutdown'])
  // A graceful shutdown that hangs leaves force shutdown as the way out.
  assert.deepEqual(rowLifecycleActions({ name: 'server1', state: 'SHUTTING_DOWN' }), ['forceShutdown'])
  assert.deepEqual(rowLifecycleActions({ name: 'AdminServer', state: 'RUNNING' }), [])
  assert.deepEqual(rowLifecycleActions({ name: 'AdminServer', state: 'ADMIN' }), [])
  assert.deepEqual(rowLifecycleActions({ name: 'server1', state: 'SUSPENDING' }), ['forceShutdown'])
  assert.deepEqual(rowLifecycleActions({ name: 'server1', state: 'STARTING' }), [])
})

test('a batch offers every action the selected servers have in common', async () => {
  const { commonBatchActions, serverLifecycleConfirmCopy } = await import('../src/routes/server-lifecycle-actions.ts')
  assert.equal(batchLifecycleAction({ name: 'server1', state: 'SHUTDOWN' }), 'start')
  assert.equal(batchLifecycleAction({ name: 'AdminServer', state: 'RUNNING' }), null)
  assert.deepEqual(
    commonBatchActions([
      { name: 'server1', state: 'RUNNING' },
      { name: 'server2', state: 'RUNNING' },
    ]),
    ['suspend', 'shutdown', 'forceShutdown'],
  )
  assert.deepEqual(
    commonBatchActions([
      { name: 'server1', state: 'SUSPENDED' },
      { name: 'server2', state: 'RUNNING' },
    ]),
    ['shutdown', 'forceShutdown'],
  )
  assert.deepEqual(commonBatchActions([{ name: 'server1', state: 'SHUTDOWN' }, { name: 'server2', state: 'RUNNING' }]), [])
  assert.match(serverLifecycleConfirmCopy('forceShutdown', 3).description, /3 selected managed servers immediately/)
  assert.match(serverLifecycleConfirmCopy('shutdown', 1).description, /no time limit/)
  assert.equal(serverLifecycleConfirmCopy('start', 1).confirmLabel, 'Confirm start')
  assert.equal(serverLifecycleConfirmCopy('resume', 2).title, 'Resume selected servers?')
})

test('server lifecycle actions are hidden in demo read-only mode', () => {
  assert.deepEqual(rowLifecycleActions({ name: 'server1', state: 'SHUTDOWN' }, { readOnlyDemoMode: true }), [])
  assert.deepEqual(rowLifecycleActions({ name: 'server1', state: 'FAILED_NOT_RESTARTABLE' }, { readOnlyDemoMode: true }), [])
  assert.deepEqual(rowLifecycleActions({ name: 'server1', state: 'RUNNING' }, { readOnlyDemoMode: true }), [])
  assert.deepEqual(rowLifecycleActions({ name: 'server1', state: 'SUSPENDED' }, { readOnlyDemoMode: true }), [])
  assert.equal(batchLifecycleAction({ name: 'server1', state: 'SHUTDOWN' }, { readOnlyDemoMode: true }), null)
  assert.equal(batchLifecycleAction({ name: 'server1', state: 'FAILED_NOT_RESTARTABLE' }, { readOnlyDemoMode: true }), null)
  assert.equal(batchLifecycleAction({ name: 'server1', state: 'RUNNING' }, { readOnlyDemoMode: true }), null)
})

test('server lifecycle labels cover all supported actions', () => {
  assert.equal(actionLabel('start'), 'Start')
  assert.equal(actionLabel('shutdown'), 'Shutdown')
  assert.equal(actionLabel('suspend'), 'Suspend')
  assert.equal(actionLabel('resume'), 'Resume')
  assert.equal(pendingLabel('suspend'), 'Suspending...')
  assert.equal(pendingLabel('resume'), 'Resuming...')
})

test('destructive lifecycle actions require confirmation', () => {
  assert.equal(isDestructiveServerLifecycleAction('start'), false)
  assert.equal(isDestructiveServerLifecycleAction('resume'), false)
  assert.equal(isDestructiveServerLifecycleAction('suspend'), true)
  assert.equal(isDestructiveServerLifecycleAction('shutdown'), true)
})

test('a batch keeps going after a failure and reports what was accepted and what failed', async () => {
  const { runServerLifecycleItems } = await import('../src/routes/server-lifecycle-actions.ts')
  const result = await runServerLifecycleItems(
    [
      { serverName: 'server1', action: 'shutdown' },
      { serverName: 'server2', action: 'shutdown' },
      { serverName: 'server3', action: 'shutdown' },
    ],
    async (item) => {
      if (item.serverName === 'server2') throw new Error('Shutdown server2: HTTP 400 Bad Request')
      return item.serverName
    },
  )
  assert.deepEqual(result.tasks, ['server1', 'server3'])
  assert.deepEqual(result.failures, ['Shutdown server2: HTTP 400 Bad Request'])
})
