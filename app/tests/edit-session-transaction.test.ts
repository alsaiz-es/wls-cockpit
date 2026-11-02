import assert from 'node:assert/strict'
import test from 'node:test'
import { runInEditSession } from '../src/api/queries/edit-session-transaction.ts'
import { WlsRestError } from '../src/api/wls-errors.ts'

function recorder(overrides: Partial<Record<'startEdit' | 'activate' | 'cancelEdit', () => Promise<unknown>>> = {}) {
  const calls: string[] = []
  const step = (name: 'startEdit' | 'activate' | 'cancelEdit') => async () => {
    calls.push(name)
    return overrides[name]?.()
  }
  return { calls, steps: { startEdit: step('startEdit'), activate: step('activate'), cancelEdit: step('cancelEdit') } }
}

test('a successful change starts, mutates and activates without cancelling', async () => {
  const { calls, steps } = recorder()
  assert.equal(await runInEditSession(steps, async () => 'done'), 'done')
  assert.deepEqual(calls, ['startEdit', 'activate'])
})

test('a failed mutation cancels the edit session', async () => {
  const { calls, steps } = recorder()
  await assert.rejects(runInEditSession(steps, async () => { throw new Error('bad change') }), /bad change/)
  assert.deepEqual(calls, ['startEdit', 'cancelEdit'])
})

test('a startEdit that timed out may hold the lock, so it is cancelled', async () => {
  const timeout = new WlsRestError({ kind: 'timeout', operation: 'Start edit', message: 'timed out' })
  const { calls, steps } = recorder({ startEdit: async () => { throw timeout } })
  await assert.rejects(runInEditSession(steps, async () => 'never'), /timed out/)
  assert.deepEqual(calls, ['startEdit', 'cancelEdit'])
})

test('a startEdit that WebLogic refused leaves any existing session alone', async () => {
  const refused = new WlsRestError({ kind: 'http', operation: 'Start edit', status: 400, message: 'locked by another user' })
  const { calls, steps } = recorder({ startEdit: async () => { throw refused } })
  await assert.rejects(runInEditSession(steps, async () => 'never'), /locked by another user/)
  assert.deepEqual(calls, ['startEdit'])
})

test('an activate without answer is reported as uncertain, not as a failure', async () => {
  const timeout = new WlsRestError({ kind: 'timeout', operation: 'Activate edit session', message: 'timed out' })
  const { calls, steps } = recorder({ activate: async () => { throw timeout } })
  await assert.rejects(runInEditSession(steps, async () => 'changed'), /may have been applied/)
  assert.deepEqual(calls, ['startEdit', 'activate', 'cancelEdit'])

  const refused = new WlsRestError({ kind: 'http', operation: 'Activate edit session', status: 400, message: 'validation failed' })
  const second = recorder({ activate: async () => { throw refused } })
  await assert.rejects(runInEditSession(second.steps, async () => 'changed'), /validation failed/)
})
