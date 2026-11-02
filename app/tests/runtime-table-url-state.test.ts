import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseRuntimeTableUrlState,
  serializeRuntimeTableUrlState,
  type RuntimeTableUrlConfig,
} from '../src/routes/runtime-table-url-state.ts'

const config: RuntimeTableUrlConfig = {
  defaultSort: { columnId: 'severity', direction: 'asc' },
  sortableColumns: ['severity', 'name', 'server'],
  filters: {
    severity: { param: 'severity', defaultValue: 'all', allowedValues: ['all', 'critical', 'warning', 'healthy'] },
    server: { param: 'server', defaultValue: 'all', allowedValues: ['all', 'AdminServer', 'server1'] },
    internal: { param: 'internal', defaultValue: false },
  },
}

test('parses search filters boolean toggles and non-default sort', () => {
  const state = parseRuntimeTableUrlState(
    new URLSearchParams('q=orders&severity=warning&server=AdminServer&internal=1&sort=name&dir=desc'),
    config,
  )

  assert.deepEqual(state, {
    search: 'orders',
    filters: {
      severity: 'warning',
      server: 'AdminServer',
      internal: true,
    },
    sort: { columnId: 'name', direction: 'desc' },
  })
})

test('serializes non-default state while preserving unrelated params', () => {
  const params = serializeRuntimeTableUrlState(
    {
      search: ' orders ',
      filters: {
        severity: 'critical',
        server: 'server1',
        internal: true,
      },
      sort: { columnId: 'server', direction: 'asc' },
    },
    config,
    new URLSearchParams('fixture=healthy&old=1'),
  )

  assert.equal(params.toString(), 'fixture=healthy&old=1&q=orders&severity=critical&server=server1&internal=1&sort=server&dir=asc')
})

test('omits defaults and default sort from serialized params', () => {
  const params = serializeRuntimeTableUrlState(
    {
      search: ' ',
      filters: {
        severity: 'all',
        server: 'all',
        internal: false,
      },
      sort: { columnId: 'severity', direction: 'asc' },
    },
    config,
    new URLSearchParams('q=old&severity=warning&internal=1&sort=name&dir=desc'),
  )

  assert.equal(params.toString(), '')
})

test('ignores invalid filter and sort values', () => {
  const state = parseRuntimeTableUrlState(
    new URLSearchParams('severity=bogus&server=missing&internal=yes&sort=bogus&dir=sideways'),
    config,
  )

  assert.deepEqual(state, {
    search: '',
    filters: {
      severity: 'all',
      server: 'all',
      internal: false,
    },
    sort: null,
  })
})
