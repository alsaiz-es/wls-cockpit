import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, type ViteDevServer } from 'vite'

interface SessionButtonsProps {
  domainName: string | undefined
  username: string | undefined
  onSwitch: () => void
  onSignOut: () => void
}

let server: ViteDevServer
let ActiveDomainName: (props: { name: string | undefined }) => React.ReactElement | null
let SessionButtons: (props: SessionButtonsProps) => React.ReactElement

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  const module = (await server.ssrLoadModule('/src/components/session-controls.tsx')) as {
    ActiveDomainName: typeof ActiveDomainName
    SessionButtons: typeof SessionButtons
  }
  ActiveDomainName = module.ActiveDomainName
  SessionButtons = module.SessionButtons
})

after(async () => {
  await server.close()
})

test('header names the connected profile, not only its host', () => {
  const markup = renderToStaticMarkup(React.createElement(ActiveDomainName, { name: '  Lab 12c  ' }))

  assert.match(markup, /data-active-domain/)
  assert.match(markup, />Lab 12c</)
  assert.match(markup, /title="Connected domain: Lab 12c"/)
  assert.equal(renderToStaticMarkup(React.createElement(ActiveDomainName, { name: ' ' })), '')
})

test('switch and sign out say what happens to the current session', () => {
  const markup = renderToStaticMarkup(
    React.createElement(SessionButtons, {
      domainName: 'Lab 12c',
      username: 'weblogic',
      onSwitch: () => undefined,
      onSignOut: () => undefined,
    }),
  )

  assert.match(markup, />Switch domain</)
  assert.match(markup, />Sign out</)
  assert.doesNotMatch(markup, />Logout</)
  assert.match(markup, /You stay connected to Lab 12c until you connect to another one\./)
  assert.match(markup, /Forget the password for Lab 12c in this tab/)
  assert.match(markup, />weblogic</)
})
