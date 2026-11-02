import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, type ViteDevServer } from 'vite'
import type { ResolvedThemeMode, ThemeMode } from '../src/theme/theme-mode.ts'

interface ThemeModeControlProps {
  mode: ThemeMode
  resolvedMode: ResolvedThemeMode
  onModeChange: (mode: ThemeMode) => void
}

interface ThemeModeButtonProps {
  'data-theme-mode': ThemeMode
  'data-selected': 'true' | 'false'
  onClick: () => void
}

let server: ViteDevServer
let ThemeModeControl: (props: ThemeModeControlProps) => React.ReactElement

before(async () => {
  // Only ssrLoadModule is used; skipping the dependency scan avoids a race where closing the
  // server mid-scan reports 'The server is being restarted or closed' and fails the file.
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  const module = await server.ssrLoadModule('/src/components/theme-mode-control.tsx') as {
    ThemeModeControl: (props: ThemeModeControlProps) => React.ReactElement
  }
  ThemeModeControl = module.ThemeModeControl
})

after(async () => {
  await server.close()
})

test('theme mode control renders compact accessible icon choices', () => {
  const markup = renderToStaticMarkup(React.createElement(ThemeModeControl, {
    mode: 'dark',
    resolvedMode: 'dark',
    onModeChange: () => undefined,
  }))

  assert.match(markup, /role="group"/)
  assert.match(markup, /aria-label="Theme mode"/)
  assert.match(markup, /aria-label="Dark theme"/)
  assert.match(markup, /aria-label="Light theme"/)
  assert.match(markup, /aria-label="System theme \(currently dark\)"/)
  assert.equal(markup.match(/<button/g)?.length, 3)
  assert.doesNotMatch(markup, />Dark theme</)
  assert.match(markup, /data-theme-mode="dark" data-selected="true"/)
  assert.match(markup, /data-theme-mode="light" data-selected="false"/)
})

test('theme mode control selection state and clicks follow the requested mode', () => {
  let selected: ThemeMode | null = null
  const element = ThemeModeControl({
    mode: 'light',
    resolvedMode: 'light',
    onModeChange: (mode) => {
      selected = mode
    },
  }) as React.ReactElement<{ children: React.ReactNode }>

  const buttons = React.Children.toArray(element.props.children) as React.ReactElement<ThemeModeButtonProps>[]
  assert.equal(buttons.find((button) => button.props['data-theme-mode'] === 'light')?.props['data-selected'], 'true')
  assert.equal(buttons.find((button) => button.props['data-theme-mode'] === 'dark')?.props['data-selected'], 'false')

  buttons.find((button) => button.props['data-theme-mode'] === 'system')?.props.onClick()
  assert.equal(selected, 'system')
})
