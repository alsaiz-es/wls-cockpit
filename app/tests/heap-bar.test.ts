import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import React, { type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, type ViteDevServer } from 'vite'

interface HeapBarProps {
  heap: { current: number; committed?: number; max: number } | null
  variant?: 'compact' | 'detail'
}

let server: ViteDevServer
let HeapBar: ComponentType<HeapBarProps>

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
  const module = await server.ssrLoadModule('/src/components/heap-bar.tsx') as {
    HeapBar: ComponentType<HeapBarProps>
  }
  HeapBar = module.HeapBar
})

after(async () => {
  await server.close()
})

test('heap bar renders committed extension only when committed exceeds used', () => {
  const committed = renderToStaticMarkup(React.createElement(HeapBar, {
    heap: { current: 50, committed: 80, max: 100 },
  }))
  assert.match(committed, /data-heap-segment="used"/)
  assert.match(committed, /data-heap-segment="committed-unused"/)
  assert.match(committed, />50%<\/span>/)
  assert.doesNotMatch(committed, /data-heap-swatch/)

  const usedOnly = renderToStaticMarkup(React.createElement(HeapBar, {
    heap: { current: 50, committed: 50, max: 100 },
  }))
  assert.match(usedOnly, /data-heap-segment="used"/)
  assert.doesNotMatch(usedOnly, /data-heap-segment="committed-unused"/)
})

test('detail heap bar renders used committed max labels and no free label', () => {
  const markup = renderToStaticMarkup(React.createElement(HeapBar, {
    heap: { current: 512 * 1024 * 1024, committed: 768 * 1024 * 1024, max: 1024 * 1024 * 1024 },
    variant: 'detail',
  }))

  assert.match(markup, /Used/)
  assert.match(markup, /Committed/)
  assert.match(markup, /Max/)
  assert.match(markup, />50%<\/span>/)
  assert.doesNotMatch(markup, /Free/)
  assert.doesNotMatch(markup, /data-heap-swatch/)
})
