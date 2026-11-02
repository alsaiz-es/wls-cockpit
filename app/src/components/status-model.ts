export const WLS_LIFECYCLE_STATES = [
  'RUNNING',
  'STARTING',
  'STANDBY',
  'ADMIN',
  'SUSPENDING',
  'SUSPENDED',
  'RESUMING',
  'SHUTTING_DOWN',
  'SHUTDOWN',
  'FORCE_SUSPENDING',
  'FAILED_NOT_RESTARTABLE',
  'UNKNOWN',
] as const

export const WLS_HEALTH_STATES = [
  'ok',
  'warn',
  'critical',
  'failed',
  'overloaded',
  'unknown',
] as const

export const STATUS_TONES = [
  'positive',
  'warning',
  'negative',
  'neutral',
  'unknown',
] as const

export type WlsLifecycleState = (typeof WLS_LIFECYCLE_STATES)[number]
export type WlsHealthState = (typeof WLS_HEALTH_STATES)[number]
export type StatusTone = (typeof STATUS_TONES)[number]

export function lifecycleTone(state: WlsLifecycleState): StatusTone {
  switch (state) {
    case 'RUNNING':
      return 'positive'
    case 'STARTING':
    case 'RESUMING':
    case 'ADMIN':
    case 'STANDBY':
    case 'SUSPENDING':
    case 'SUSPENDED':
    case 'FORCE_SUSPENDING':
    case 'SHUTTING_DOWN':
      return 'warning'
    case 'SHUTDOWN':
      return 'neutral'
    case 'FAILED_NOT_RESTARTABLE':
      return 'negative'
    case 'UNKNOWN':
      return 'unknown'
  }
}

export function healthTone(state: WlsHealthState): StatusTone {
  switch (state) {
    case 'ok':
      return 'positive'
    case 'warn':
    case 'overloaded':
      return 'warning'
    case 'critical':
    case 'failed':
      return 'negative'
    case 'unknown':
      return 'unknown'
  }
}
