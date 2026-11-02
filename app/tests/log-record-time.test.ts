import assert from 'node:assert/strict'
import test from 'node:test'
import { logClockTime, logDayLabel, logDaySeparator, logRecordTime } from '../src/routes/log-record-time.ts'

const morning = new Date(2026, 10, 2, 9, 5, 7, 42).getTime()
const evening = new Date(2026, 10, 2, 23, 59, 59, 999).getTime()
const nextDay = new Date(2026, 10, 3, 0, 0, 1, 0).getTime()

test('log times are local time of day to the millisecond', () => {
  assert.equal(logClockTime(morning), '09:05:07.042')
  assert.equal(logClockTime(evening), '23:59:59.999')
})

test('a record without a parsed timestamp keeps the raw WebLogic date', () => {
  assert.deepEqual(logRecordTime({ timestamp: null, date: 'Nov 2, 2026 9:05:07 AM' }), {
    text: 'Nov 2, 2026 9:05:07 AM',
    title: 'Nov 2, 2026 9:05:07 AM',
  })
  assert.equal(logRecordTime({ timestamp: null }).text, '–')
  assert.equal(logRecordTime({ timestamp: morning }).text, '09:05:07.042')
})

test('a day separator opens the list and marks every change of day, in either order', () => {
  const ascending = [{ timestamp: morning }, { timestamp: evening }, { timestamp: null }, { timestamp: nextDay }]
  assert.deepEqual(
    ascending.map((_, index) => logDaySeparator(ascending, index)),
    [logDayLabel(morning), null, null, logDayLabel(nextDay)],
  )
  const descending = [...ascending].reverse()
  assert.deepEqual(
    descending.map((_, index) => logDaySeparator(descending, index)),
    [logDayLabel(nextDay), null, logDayLabel(evening), null],
  )
})
