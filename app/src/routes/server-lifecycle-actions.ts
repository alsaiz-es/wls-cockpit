import type { ServerLifecycleAction } from '@/api/queries/server-lifecycle'
import type { WlsLifecycleState } from '@/components'

export type ServerLifecycleBatchAction = ServerLifecycleAction
export type DestructiveServerLifecycleAction = Extract<ServerLifecycleAction, 'shutdown' | 'forceShutdown' | 'suspend'>

export interface ServerLifecycleActionInput {
  name: string
  state: WlsLifecycleState
}

export interface ServerLifecycleModeOptions {
  readOnlyDemoMode?: boolean
}

export function rowLifecycleActions(
  row: ServerLifecycleActionInput,
  options: ServerLifecycleModeOptions = {},
): ServerLifecycleAction[] {
  if (options.readOnlyDemoMode) return []
  if (row.name === 'AdminServer') return []
  if (row.state === 'SHUTDOWN' || row.state === 'FAILED_NOT_RESTARTABLE') return ['start']
  if (row.state === 'RUNNING') return ['suspend', 'shutdown', 'forceShutdown']
  if (row.state === 'SUSPENDED' || row.state === 'ADMIN' || row.state === 'STANDBY') return ['resume', 'shutdown', 'forceShutdown']
  // A graceful shutdown or suspend can hang on in-flight work; force shutdown is the way out.
  if (TRANSITIONAL_STATES.has(row.state)) return ['forceShutdown']
  return []
}

const TRANSITIONAL_STATES = new Set<string>(['SHUTTING_DOWN', 'SUSPENDING', 'FORCE_SUSPENDING', 'RESUMING'])

// Actions every selected row allows, so one batch can run them all (start, suspend, resume,
// shutdown or force shutdown) instead of only start/shutdown.
export function commonBatchActions(
  rows: ServerLifecycleActionInput[],
  options: ServerLifecycleModeOptions = {},
): ServerLifecycleAction[] {
  if (rows.length === 0) return []
  const [first, ...rest] = rows.map((row) => rowLifecycleActions(row, options))
  return first.filter((action) => rest.every((actions) => actions.includes(action)))
}

export function batchLifecycleAction(
  row: ServerLifecycleActionInput,
  options: ServerLifecycleModeOptions = {},
): ServerLifecycleBatchAction | null {
  if (options.readOnlyDemoMode) return null
  if (row.name === 'AdminServer') return null
  return rowLifecycleActions(row, options)[0] ?? null
}

export function isDestructiveServerLifecycleAction(
  action: ServerLifecycleAction,
): action is DestructiveServerLifecycleAction {
  return action === 'shutdown' || action === 'forceShutdown' || action === 'suspend'
}

export function serverLifecycleConfirmCopy(action: ServerLifecycleAction, count: number) {
  const servers = count === 1 ? 'the selected managed server' : `every one of the ${count} selected managed servers`
  if (action === 'start') {
    return {
      title: count === 1 ? 'Start server?' : 'Start selected servers?',
      description: `This asks Node Manager to start ${servers}. It joins its cluster and starts taking traffic once RUNNING.`,
      confirmLabel: 'Confirm start',
    }
  }
  if (action === 'resume') {
    return {
      title: count === 1 ? 'Resume server?' : 'Resume selected servers?',
      description: `This resumes ${servers}, which starts taking normal request traffic again.`,
      confirmLabel: 'Confirm resume',
    }
  }
  if (action === 'forceShutdown') {
    return {
      title: count === 1 ? 'Force shutdown server?' : 'Force shutdown selected servers?',
      description: `This stops ${servers} immediately. In-flight requests and transactions are dropped; use it when a graceful shutdown hangs.`,
      confirmLabel: 'Confirm force shutdown',
    }
  }
  if (action === 'suspend') {
    return {
      title: count === 1 ? 'Suspend server?' : 'Suspend selected servers?',
      description: `This suspends ${servers} and stops normal request traffic.`,
      confirmLabel: 'Confirm suspend',
    }
  }
  return {
    title: count === 1 ? 'Shutdown server?' : 'Shutdown selected servers?',
    description: `This requests a graceful shutdown of ${servers}: WebLogic waits for in-flight work, with no time limit. Use force shutdown if it hangs.`,
    confirmLabel: 'Confirm shutdown',
  }
}

export function actionLabel(action: ServerLifecycleAction) {
  if (action === 'start') return 'Start'
  if (action === 'shutdown') return 'Shutdown'
  if (action === 'forceShutdown') return 'Force shutdown'
  if (action === 'suspend') return 'Suspend'
  return 'Resume'
}

export function pendingLabel(action: ServerLifecycleAction) {
  if (action === 'start') return 'Starting...'
  if (action === 'shutdown') return 'Stopping...'
  if (action === 'forceShutdown') return 'Forcing...'
  if (action === 'suspend') return 'Suspending...'
  return 'Resuming...'
}

export interface ServerLifecycleItem {
  serverName: string
  action: ServerLifecycleAction
}

function lifecycleFailureMessage(item: ServerLifecycleItem, error: unknown) {
  const message = error instanceof Error ? error.message : 'Lifecycle action failed.'
  const prefix = `${actionLabel(item.action)} ${item.serverName}`
  // Lifecycle errors already name the action and server; do not repeat them.
  return message.startsWith(`${prefix}:`) ? message : `${prefix}: ${message}`
}

// Runs every item even when one fails: servers are independent, and stopping at the first error
// used to hide which of the earlier ones WebLogic had already accepted.
export async function runServerLifecycleItems<T>(
  items: ServerLifecycleItem[],
  run: (item: ServerLifecycleItem) => Promise<T>,
): Promise<{ tasks: T[]; failures: string[] }> {
  const tasks: T[] = []
  const failures: string[] = []
  for (const item of items) {
    try {
      tasks.push(await run(item))
    } catch (error) {
      failures.push(lifecycleFailureMessage(item, error))
    }
  }
  return { tasks, failures }
}
