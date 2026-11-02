import { createHash } from 'node:crypto'

// Keeps a burst of Cockpit requests from turning into a burst of failed WebLogic logins (with the
// default realm settings, five failures lock the user out). Per target and Authorization header:
// - after a 401, requests are refused locally until a sign-in request succeeds;
// - when the last success is older than FRESH_MS (the password may have changed since), one
//   request goes through as a probe and the rest wait for its answer.
// FRESH_MS stays well under the shortest polling interval (10 s), so every poll cycle starts with
// one probe; requests chained within a cycle pass straight through.
export const CREDENTIAL_FRESH_MS = 2_000
// A slow probe (a log search, a thread dump) holds the others back at most this long; giving up
// costs at most one more failed login.
export const CREDENTIAL_PROBE_WAIT_MS = 10_000
const MAX_ENTRIES = 200

type Entry = {
  state: 'unknown' | 'good' | 'rejected'
  at: number
  probe: Promise<void> | null
}

export type CredentialAdmission =
  | { ok: true; settle: (status: number | null) => void }
  | { ok: false }

export function credentialKey(targetUrl: string, authorization: string | null | undefined) {
  if (!authorization) return null
  return createHash('sha256').update(`${targetUrl}\0${authorization}`).digest('hex')
}

export class CredentialGuard {
  private readonly entries = new Map<string, Entry>()
  private readonly now: () => number

  private readonly probeWaitMs: number

  constructor(now: () => number = Date.now, probeWaitMs = CREDENTIAL_PROBE_WAIT_MS) {
    this.now = now
    this.probeWaitMs = probeWaitMs
  }

  private async waitForProbe(entry: Entry) {
    while (entry.probe) {
      const probe = entry.probe
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = await Promise.race([
        probe.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), this.probeWaitMs)
        }),
      ])
      clearTimeout(timer)
      if (timedOut && entry.probe === probe) entry.probe = null
    }
  }

  private entry(key: string) {
    let entry = this.entries.get(key)
    if (!entry) {
      if (this.entries.size >= MAX_ENTRIES) {
        const oldest = this.entries.keys().next().value
        if (oldest !== undefined) this.entries.delete(oldest)
      }
      entry = { state: 'unknown', at: 0, probe: null }
      this.entries.set(key, entry)
    }
    return entry
  }

  isRejected(key: string | null) {
    return !!key && this.entries.get(key)?.state === 'rejected'
  }

  // A sign-in request always goes through; its answer decides the state.
  async admit(key: string | null, signIn = false): Promise<CredentialAdmission> {
    if (!key) return { ok: true, settle: () => undefined }
    const entry = this.entry(key)
    if (!signIn) {
      await this.waitForProbe(entry)
      if (entry.state === 'rejected') return { ok: false }
      if (entry.state === 'good' && this.now() - entry.at < CREDENTIAL_FRESH_MS) {
        return { ok: true, settle: (status) => this.record(entry, status) }
      }
    }

    let release: () => void = () => undefined
    const probe = new Promise<void>((resolve) => {
      release = resolve
    })
    if (!signIn) entry.probe = probe
    return {
      ok: true,
      settle: (status) => {
        this.record(entry, status)
        if (entry.probe === probe) entry.probe = null
        release()
      },
    }
  }

  // null: no answer (network error); the state is left as it was.
  private record(entry: Entry, status: number | null) {
    if (status === null) return
    if (status === 401) {
      entry.state = 'rejected'
    } else {
      entry.state = 'good'
      entry.at = this.now()
    }
  }
}

export const defaultCredentialGuard = new CredentialGuard()
