import assert from 'node:assert/strict'
import test from 'node:test'
import { formatRelativeTime, toRelativeDate } from '../src/components/relative-time-format.ts'

const now = Date.UTC(2026, 3, 30, 12, 0, 0)

test('formats relative time across second minute and hour boundaries', () => {
  assert.equal(formatRelativeTime(new Date(now), now), 'just now')
  assert.equal(formatRelativeTime(new Date(now - 59_000), now), 'just now')
  assert.equal(formatRelativeTime(new Date(now - 60_000), now), '1m ago')
  assert.equal(formatRelativeTime(new Date(now - 59 * 60_000), now), '59m ago')
  assert.equal(formatRelativeTime(new Date(now - 60 * 60_000), now), '1h ago')
  assert.equal(formatRelativeTime(new Date(now - 23 * 60 * 60_000), now), '23h ago')
})

test('clamps future relative timestamps to the current second', () => {
  assert.equal(formatRelativeTime(new Date(now + 30_000), now), 'just now')
})

test('normalizes relative time input values', () => {
  assert.equal(toRelativeDate(null), null)
  assert.equal(toRelativeDate(undefined), null)
  assert.equal(toRelativeDate(0), null)
  assert.equal(toRelativeDate('not a date'), null)
  assert.equal(toRelativeDate(now)?.toISOString(), '2026-04-30T12:00:00.000Z')
  assert.equal(toRelativeDate('2026-04-30T12:00:00.000Z')?.getTime(), now)
})
