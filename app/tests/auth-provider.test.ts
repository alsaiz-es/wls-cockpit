import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createServer, type ViteDevServer } from 'vite'
import type { WlsCredentials } from '../src/api/client.ts'
import type { AuthContextValue } from '../src/auth/auth-context.ts'

let server: ViteDevServer
let AuthProvider: (props: { children: React.ReactNode }) => React.ReactElement
let useAuth: () => AuthContextValue

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  AuthProvider = ((await server.ssrLoadModule('/src/auth/AuthContext.tsx')) as {
    AuthProvider: typeof AuthProvider
  }).AuthProvider
  useAuth = ((await server.ssrLoadModule('/src/auth/useAuth.ts')) as { useAuth: typeof useAuth }).useAuth
})

after(async () => {
  await server.close()
})

const creds: WlsCredentials = {
  profileId: 'profile-a',
  name: 'Lab A',
  targetUrl: 'http://wls-admin.example.com:7001',
  username: 'weblogic',
  password: 'secret-pass',
  version: '14.1.2.0.0',
}

function renderAuth(queryClient: QueryClient) {
  let auth: AuthContextValue | null = null
  function Probe() {
    auth = useAuth()
    return null
  }
  renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(AuthProvider, null, React.createElement(Probe)),
    ),
  )
  assert.ok(auth)
  return auth as AuthContextValue
}

// The query keys leave the password out, so data cached under one login must not survive into
// the next one (wrong password, changed password, another domain).
test('login and logout drop every cached query', () => {
  const queryClient = new QueryClient()
  const auth = renderAuth(queryClient)

  queryClient.setQueryData(['servers', 'cached-before-login'], { ok: true })
  auth.login(creds)
  assert.equal(queryClient.getQueryCache().getAll().length, 0)

  queryClient.setQueryData(['servers', 'cached-before-logout'], { ok: true })
  auth.logout()
  assert.equal(queryClient.getQueryCache().getAll().length, 0)
})
