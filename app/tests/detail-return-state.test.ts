import assert from 'node:assert/strict'
import test from 'node:test'
import { detailReturnPath, detailReturnState } from '../src/routes/detail-return-state.ts'

test('builds detail return state from list location', () => {
  assert.deepEqual(detailReturnState({ pathname: '/deployments', search: '?q=demo&sort=name&dir=desc' }), {
    returnTo: '/deployments?q=demo&sort=name&dir=desc',
  })
})

test('accepts valid same-list return paths', () => {
  assert.equal(detailReturnPath({ returnTo: '/servers?state=RUNNING' }, '/servers'), '/servers?state=RUNNING')
  assert.equal(detailReturnPath({ returnTo: '/logs#top' }, '/logs'), '/logs#top')
})

test('falls back for direct loads and malformed state', () => {
  assert.equal(detailReturnPath(null, '/data-sources'), '/data-sources')
  assert.equal(detailReturnPath({ returnTo: 42 }, '/data-sources'), '/data-sources')
  assert.equal(detailReturnPath({ other: '/data-sources?q=x' }, '/data-sources'), '/data-sources')
})

test('rejects cross-route and near-prefix return paths', () => {
  assert.equal(detailReturnPath({ returnTo: '/deployments?q=x' }, '/servers'), '/servers')
  assert.equal(detailReturnPath({ returnTo: '/servers2?q=x' }, '/servers'), '/servers')
  assert.equal(detailReturnPath({ returnTo: 'https://example.com/servers?q=x' }, '/servers'), '/servers')
})
