import { useSyncExternalStore } from 'react'
import { MonoText } from './mono-text'
import { formatRelativeTime, toRelativeDate } from './relative-time-format.ts'

type Subscriber = () => void

const subscribers = new Set<Subscriber>()
let interval: number | null = null
let currentSnapshot = Date.now()

function subscribe(callback: Subscriber) {
  subscribers.add(callback)
  if (interval === null) {
    currentSnapshot = Date.now()
    interval = window.setInterval(() => {
      currentSnapshot = Date.now()
      subscribers.forEach((subscriber) => subscriber())
    }, 30_000)
  }

  return () => {
    subscribers.delete(callback)
    if (subscribers.size === 0 && interval !== null) {
      window.clearInterval(interval)
      interval = null
    }
  }
}

function getSnapshot() {
  return currentSnapshot
}

export interface RelativeTimeProps {
  value: Date | number | string | null | undefined
  className?: string
}

export function RelativeTime({ value, className }: RelativeTimeProps) {
  const now = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const date = toRelativeDate(value)

  if (!date) {
    return <MonoText className={className}>–</MonoText>
  }

  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString(undefined, { timeZoneName: 'short' })}>
      <MonoText className={className}>{formatRelativeTime(date, now)}</MonoText>
    </time>
  )
}
