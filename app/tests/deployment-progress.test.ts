import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deploymentStateLabel,
  settleDeploymentProgress,
} from '../src/api/queries/deployment-progress.ts'
import { progressNeedsRestart } from '../src/api/queries/deployment-progress.ts'

const noSleep = async () => undefined

test('a running deployment is polled until WebLogic reports the outcome', async () => {
  const states = ['STATE_RUNNING', 'STATE_FAILED']
  const fetched: string[] = []
  const final = await settleDeploymentProgress(
    { name: 'ADTR-7', state: 'STATE_RUNNING' },
    async (name) => {
      fetched.push(name)
      return { name, state: states.shift() }
    },
    { sleep: noSleep },
  )
  assert.deepEqual(fetched, ['ADTR-7', 'ADTR-7'])
  assert.deepEqual(final, { name: 'ADTR-7', state: 'STATE_FAILED' })
})

test('a completed answer is not polled', async () => {
  const final = await settleDeploymentProgress({ name: 'ADTR-8', state: 'STATE_COMPLETED' }, async () => assert.fail('no poll'), {
    sleep: noSleep,
  })
  assert.deepEqual(final, { name: 'ADTR-8', state: 'STATE_COMPLETED' })
})

function fakeClock() {
  let time = 0
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms
    },
    advance: (ms: number) => {
      time += ms
    },
  }
}

test('polling stops at the wait budget and leaves the state as still running', async () => {
  const clock = fakeClock()
  let polls = 0
  const final = await settleDeploymentProgress(
    { name: 'ADTR-9', state: 'STATE_RUNNING' },
    async (name) => {
      polls += 1
      return { name, state: 'STATE_RUNNING' }
    },
    { sleep: clock.sleep, now: clock.now, pollMs: 1_000, maxWaitMs: 5_000 },
  )
  assert.equal(polls, 5)
  assert.equal(deploymentStateLabel((final as { state: string }).state), 'still running')
})

test('slow progress reads count against the wait budget', async () => {
  const clock = fakeClock()
  let polls = 0
  await settleDeploymentProgress(
    { name: 'ADTR-10', state: 'STATE_RUNNING' },
    async (name) => {
      polls += 1
      clock.advance(10_000)
      return { name, state: 'STATE_RUNNING' }
    },
    { sleep: clock.sleep, now: clock.now, pollMs: 2_000, maxWaitMs: 120_000 },
  )
  assert.equal(polls, 10)
})

test('a progress read that fails returns the last known state with a note, not an error', async () => {
  const clock = fakeClock()
  const final = (await settleDeploymentProgress(
    { name: 'ADTR-11', state: 'STATE_RUNNING', messages: ['Started'] },
    async () => {
      throw new Error('Deployment progress ADTR-11: HTTP 404')
    },
    { sleep: clock.sleep, now: clock.now },
  )) as { state: string; messages: string[] }
  assert.equal(final.state, 'STATE_RUNNING')
  assert.deepEqual(final.messages, ['Started', 'Cockpit could not keep following the progress: Deployment progress ADTR-11: HTTP 404'])
})

test('states read as words instead of STATE_* constants', () => {
  assert.equal(deploymentStateLabel('STATE_COMPLETED'), 'completed')
  assert.equal(deploymentStateLabel('STATE_DEFERRED'), 'deferred until the targets are available')
  assert.equal(deploymentStateLabel(null), null)
})

test('a completed deploy that waits for a server restart is recognised', () => {
  assert.equal(
    progressNeedsRestart({
      state: 'STATE_COMPLETED',
      deploymentMessages: ['[Deployer:149034]An exception occurred for task: [Deployer:149169]Requires server restart for completion..'],
    }),
    true,
  )
  assert.equal(progressNeedsRestart({ state: 'STATE_COMPLETED', deploymentMessages: ['ok'] }), false)
  assert.equal(progressNeedsRestart(null), false)
})
