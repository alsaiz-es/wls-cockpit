import assert from 'node:assert/strict'
import test from 'node:test'
import { routeParam } from '../src/routes/route-params.ts'

test('route params are not decoded twice', () => {
  // React Router hands over 'app%v2' for the URL segment app%25v2; decoding again threw URIError.
  assert.equal(routeParam('app%v2'), 'app%v2')
  assert.equal(routeParam('jms%2Fqueue'), 'jms/queue')
  assert.equal(routeParam('Service Bus Email Transport Provider'), 'Service Bus Email Transport Provider')
  assert.equal(routeParam(undefined), '')
})
