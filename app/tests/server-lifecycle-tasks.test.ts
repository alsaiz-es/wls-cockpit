import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createServerLifecycleTaskPollingInterval,
  normalizeServerLifecycleHistory,
  SERVER_LIFECYCLE_TASK_QUERY_OPTIONS,
  SERVER_LIFECYCLE_TASK_REQUEST_TIMEOUT_MS,
  serverLifecycleTaskQueryParams,
} from '../src/api/queries/server-lifecycle-tasks.ts'
import {
  ADAPTIVE_POLL_FAST_INTERVAL_MS,
  ADAPTIVE_POLL_SLOW_INTERVAL_MS,
} from '../src/api/query-polling.ts'

test('server lifecycle task query uses bounded fields and suppresses links', () => {
  const params = serverLifecycleTaskQueryParams()

  assert.match(params.fields, /\bname\b/)
  assert.match(params.fields, /\boperation\b/)
  assert.match(params.fields, /\btaskStatus\b/)
  assert.match(params.fields, /\bstartTimeAsLong\b/)
  assert.match(params.fields, /\btaskError\b/)
  assert.doesNotMatch(params.fields, /\bsubTasks\b/)
  assert.equal(params.links, 'none')
})

test('server lifecycle task query options use split polling pressure', () => {
  assert.equal(SERVER_LIFECYCLE_TASK_REQUEST_TIMEOUT_MS, 15_000)
  assert.ok(SERVER_LIFECYCLE_TASK_REQUEST_TIMEOUT_MS < 30_000)
  assert.equal(SERVER_LIFECYCLE_TASK_QUERY_OPTIONS.staleTime, 0)
  assert.equal(SERVER_LIFECYCLE_TASK_QUERY_OPTIONS.refetchInterval, ADAPTIVE_POLL_SLOW_INTERVAL_MS)
})

test('server lifecycle task polling is fast for active or recently changed snapshots then slows', () => {
  const interval = createServerLifecycleTaskPollingInterval()
  const completed = [
    {
      serverName: 'AdminServer',
      name: '_1_start',
      operation: 'start',
      status: 'TASK COMPLETED',
      progress: 'success',
      running: false,
      completed: true,
      description: null,
      startTime: 1,
      endTime: 2,
      errorMessage: null,
    },
  ]
  const running = [{ ...completed[0], status: 'TASK IN PROGRESS', progress: 'processing', running: true, completed: false }]

  assert.equal(interval(undefined), ADAPTIVE_POLL_SLOW_INTERVAL_MS)
  assert.equal(interval(running), ADAPTIVE_POLL_FAST_INTERVAL_MS)
  assert.equal(interval(completed), ADAPTIVE_POLL_FAST_INTERVAL_MS)
  assert.equal(interval(completed), ADAPTIVE_POLL_FAST_INTERVAL_MS)
  assert.equal(interval(completed), ADAPTIVE_POLL_SLOW_INTERVAL_MS)
})

test('normalizes live WebLogic server lifecycle task field names newest first', () => {
  const tasks = normalizeServerLifecycleHistory(
    {
      items: [
        {
          name: '_0_suspendWithTimeout',
          operation: 'suspendWithTimeout',
          taskStatus: 'TASK COMPLETED',
          progress: 'success',
          description: 'suspending server1 server ...',
          serverName: 'server1',
          running: false,
          completed: true,
          startTimeAsLong: Date.UTC(2026, 3, 30, 12, 0, 0),
          endTimeAsLong: Date.UTC(2026, 3, 30, 12, 0, 1),
          taskError: null,
        },
        {
          name: '_1_resume',
          operation: 'resume',
          taskStatus: 'TASK COMPLETED',
          progress: 'success',
          description: 'Resuming server1 server ...',
          serverName: 'server1',
          running: false,
          completed: true,
          startTimeAsLong: Date.UTC(2026, 3, 30, 12, 1, 0),
          endTimeAsLong: Date.UTC(2026, 3, 30, 12, 1, 1),
          taskError: null,
        },
      ],
    },
    'server1',
  )

  assert.equal(tasks.length, 2)
  assert.equal(tasks[0].operation, 'resume')
  assert.equal(tasks[0].status, 'TASK COMPLETED')
  assert.equal(tasks[0].progress, 'success')
  assert.equal(tasks[0].startTime, Date.UTC(2026, 3, 30, 12, 1, 0))
  assert.equal(tasks[0].endTime, Date.UTC(2026, 3, 30, 12, 1, 1))
  assert.equal(tasks[1].operation, 'suspendWithTimeout')
})

test('normalizes documented task fields and ISO timestamps', () => {
  const tasks = normalizeServerLifecycleHistory(
    {
      items: [
        {
          name: '_2_shutdown',
          operation: 'shutdown',
          status: 'TASK COMPLETED',
          progress: 'success',
          description: 'Shutting down server1',
          running: false,
          beginTime: Date.parse('2026-04-30T12:02:00.000Z'),
          endTime: -1,
        },
        {
          name: '_3_start',
          operation: 'start',
          status: 'TASK IN PROGRESS',
          progress: 'processing',
          startTime: '2026-04-30T12:03:00.000Z',
          endTime: '2026-04-30T12:04:00.000Z',
          error: {
            message: 'Failed with password=secret and Basic abcdef',
          },
        },
      ],
    },
    'server1',
  )

  assert.equal(tasks.length, 2)
  assert.equal(tasks[0].name, '_3_start')
  assert.equal(tasks[0].startTime, Date.parse('2026-04-30T12:03:00.000Z'))
  assert.equal(tasks[0].endTime, Date.parse('2026-04-30T12:04:00.000Z'))
  assert.equal(tasks[0].errorMessage, 'Failed with password=[redacted] and Basic [redacted]')
  assert.equal(tasks[1].serverName, 'server1')
  assert.equal(tasks[1].endTime, null)
})

test('normalizes empty and malformed task collections', () => {
  assert.deepEqual(normalizeServerLifecycleHistory({}, 'server1'), [])
  assert.deepEqual(normalizeServerLifecycleHistory({ items: [null, 'bad'] }, 'server1'), [])
})
