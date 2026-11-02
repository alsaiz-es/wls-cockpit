import { CREDENTIALS_REJECTED_HEADER } from './credential-guard-contract.ts'

// Watches every response the browser gets from the local server: one marked as rejected
// credentials signs the session out, so polling stops instead of piling up failed logins.
type Listener = () => void

const listeners = new Set<Listener>()
let installed = false

export function onCredentialsRejected(listener: Listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function responseRejectsCredentials(response: Response) {
  return response.status === 401 && response.headers.get(CREDENTIALS_REJECTED_HEADER) === '1'
}

export function installCredentialRejectionWatch(scope: { fetch: typeof fetch } = globalThis) {
  if (installed) return
  installed = true
  const original = scope.fetch.bind(scope)
  scope.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await original(...args)
    if (responseRejectsCredentials(response)) listeners.forEach((listener) => listener())
    return response
  }
}

const NOTICE_KEY = 'wls-cockpit:sign-in-notice'

export function writeSignInNotice(message: string) {
  try {
    sessionStorage.setItem(NOTICE_KEY, message)
  } catch {
    // Storage unavailable: the login form just shows no notice.
  }
}

// Read and clear are separate so a component can read during render and clear in an effect.
export function readSignInNotice() {
  try {
    return sessionStorage.getItem(NOTICE_KEY)
  } catch {
    return null
  }
}

export function clearSignInNotice() {
  try {
    sessionStorage.removeItem(NOTICE_KEY)
  } catch {
    // Nothing to clear.
  }
}
