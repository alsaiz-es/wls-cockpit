import assert from 'node:assert/strict'
import test from 'node:test'
import { wlsCredentialCacheKey } from '../src/api/client.ts'
import {
  WlsRestError,
  createWlsHttpError,
  wlsErrorDetail,
  normalizeWlsRestError,
  withWlsRestTimeout,
} from '../src/api/wls-errors.ts'

test('credential cache key leaves the password out', () => {
  const first = wlsCredentialCacheKey({
    profileId: 'profile-a',
    name: 'Lab A',
    targetUrl: 'http://wls-a.example.com:7001',
    username: 'admin',
    password: 'secret-pass',
    version: '14.1.2.0.0',
  })
  const second = wlsCredentialCacheKey({
    profileId: 'profile-a',
    name: 'Lab A',
    targetUrl: 'http://wls-a.example.com:7001',
    username: 'admin',
    password: 'different',
    version: '14.1.2.0.0',
  })

  // The login and logout paths clear the query cache instead (tests/auth-provider.test.ts).
  assert.equal(first, second)
  assert.doesNotMatch(first, /secret-pass/)
})

test('normalizes HTTP 401 without exposing credentials', () => {
  const error = createWlsHttpError('Server runtimes', new Response('no', { status: 401, statusText: 'Unauthorized' }))

  assert.equal(error.kind, 'http')
  assert.equal(error.status, 401)
  assert.match(error.message, /authentication failed/)
  assert.doesNotMatch(error.message, /Basic/i)
  assert.doesNotMatch(error.message, /welcome/i)
})

test('normalizes aborts as timeout errors', () => {
  const abort = new DOMException('The operation was aborted.', 'AbortError')
  const error = normalizeWlsRestError('Server runtimes', abort, 5_000)

  assert.equal(error.kind, 'timeout')
  assert.equal(error.operation, 'Server runtimes')
  assert.match(error.message, /timed out after 5s/)
})

test('normalizes transport failures', () => {
  const error = normalizeWlsRestError('Server runtimes', new TypeError('fetch failed'))

  assert.equal(error.kind, 'transport')
  assert.match(error.message, /fetch failed/)
})

test('withWlsRestTimeout aborts and throws WlsRestError', async () => {
  await assert.rejects(
    () =>
      withWlsRestTimeout(
        'Slow request',
        (signal) =>
          new Promise((resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('The operation was aborted.', 'AbortError')),
              { once: true },
            )
            globalThis.setTimeout(() => resolve('late'), 50)
          }),
        5,
      ),
    (error: unknown) => error instanceof WlsRestError && error.kind === 'timeout',
  )
})

test('WebLogic error detail is added to the message without the Java exception chain', () => {
  // Body returned by 14.1.2 when a start fails because Node Manager cannot be reached.
  const body = {
    status: 400,
    title: 'FAILURE',
    detail:
      'java.lang.RuntimeException: java.lang.IllegalStateException: TrustManagerFactoryImpl is not initialized. Could not connect to NodeManager. Check that it is running at localhost/127.0.0.1:5556.',
  }
  assert.equal(
    wlsErrorDetail(body),
    'TrustManagerFactoryImpl is not initialized. Could not connect to NodeManager. Check that it is running at localhost/127.0.0.1:5556.',
  )
  const error = createWlsHttpError('Start server1', new Response(null, { status: 400, statusText: 'Bad Request' }), body)
  assert.match(error.message, /^Start server1: HTTP 400 Bad Request: TrustManagerFactoryImpl is not initialized\. Could not connect to NodeManager/)

  assert.equal(wlsErrorDetail({ 'wls:errorsDetails': [{ detail: 'Name already in use.' }] }), 'Name already in use.')
  assert.equal(wlsErrorDetail(undefined), null)
  assert.equal(wlsErrorDetail({ detail: '  ' }), null)
  assert.equal(wlsErrorDetail({ detail: 'x'.repeat(400) })?.length, 300)
  assert.equal(
    createWlsHttpError('Deploy', new Response(null, { status: 400, statusText: 'Bad Request' })).message,
    'Deploy: HTTP 400 Bad Request',
  )
})
