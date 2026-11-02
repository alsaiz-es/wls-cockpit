// Stops Cockpit when its last browser tab closes, for runs started by double-click (the macOS app
// and WLS Cockpit.exe), which have no terminal or window to stop them from. Each tab reports
// open, a heartbeat while it lives, and close (a beacon on pagehide). With no tab left, Cockpit
// waits GRACE_MS, so a reload or a quick reopen keeps it running, then stops. A tab that vanished
// without a close (browser crash) counts as gone after STALE_MS without heartbeats; that is long
// because browsers slow timers in background tabs to about one a minute.
export const TAB_PRESENCE_GRACE_MS = 10_000
export const TAB_PRESENCE_STALE_MS = 10 * 60_000
const MAX_TABS = 200

export type TabPresenceEvent = 'open' | 'heartbeat' | 'close'

export interface TabPresenceOptions {
  onLastTabClosed: () => void
  graceMs?: number
  staleMs?: number
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => { cancel: () => void }
}

const TAB_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/

export function parseTabPresenceMessage(raw: string): { id: string; event: TabPresenceEvent } | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const { id, event } = value as Record<string, unknown>
  if (typeof id !== 'string' || !TAB_ID_PATTERN.test(id)) return null
  if (event !== 'open' && event !== 'heartbeat' && event !== 'close') return null
  return { id, event }
}

function defaultTimer(callback: () => void, ms: number) {
  const timer = setTimeout(callback, ms)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

export class TabPresence {
  private readonly tabs = new Map<string, number>()
  private readonly options: Required<Omit<TabPresenceOptions, 'onLastTabClosed'>> & Pick<TabPresenceOptions, 'onLastTabClosed'>
  private shutdownTimer: { cancel: () => void } | null = null
  private sweepTimer: { cancel: () => void } | null = null
  private seenTab = false

  constructor(options: TabPresenceOptions) {
    this.options = {
      graceMs: TAB_PRESENCE_GRACE_MS,
      staleMs: TAB_PRESENCE_STALE_MS,
      now: Date.now,
      setTimer: defaultTimer,
      ...options,
    }
  }

  get openTabs() {
    return this.tabs.size
  }

  record(id: string, event: TabPresenceEvent) {
    if (event === 'close') {
      this.tabs.delete(id)
    } else if (this.tabs.has(id) || this.tabs.size < MAX_TABS) {
      this.tabs.set(id, this.options.now())
      this.seenTab = true
      this.shutdownTimer?.cancel()
      this.shutdownTimer = null
    }
    this.scheduleSweep()
    this.checkEmpty()
  }

  // Drops tabs whose heartbeats stopped, then checks whether any is left.
  sweep() {
    const cutoff = this.options.now() - this.options.staleMs
    for (const [id, lastSeen] of this.tabs) {
      if (lastSeen < cutoff) this.tabs.delete(id)
    }
    this.sweepTimer = null
    this.scheduleSweep()
    this.checkEmpty()
  }

  private scheduleSweep() {
    if (this.sweepTimer || this.tabs.size === 0) return
    this.sweepTimer = this.options.setTimer(() => this.sweep(), Math.max(1_000, Math.floor(this.options.staleMs / 4)))
  }

  private checkEmpty() {
    // Before the first tab connects (the browser may still be starting) there is nothing to wait for.
    if (!this.seenTab || this.tabs.size > 0 || this.shutdownTimer) return
    this.shutdownTimer = this.options.setTimer(() => {
      this.shutdownTimer = null
      if (this.tabs.size === 0) this.options.onLastTabClosed()
    }, this.options.graceMs)
  }
}
