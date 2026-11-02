// Deployment operations return a DeploymentProgressObject. WebLogic may answer before the work
// finishes (STATE_RUNNING), so reporting the first answer as success could claim a deploy that
// later fails. The progress object is polled until it settles or the wait budget runs out.

export const DEPLOYMENT_PROGRESS_POLL_MS = 2_000
export const DEPLOYMENT_PROGRESS_MAX_WAIT_MS = 120_000

const PENDING_STATES = new Set(['STATE_INITIALIZED', 'STATE_RUNNING'])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function deploymentProgressState(data: unknown): string | null {
  if (!isObject(data)) return null
  const state = data.state ?? data.progress
  return typeof state === 'string' && state.trim() ? state.trim() : null
}

export function deploymentProgressPending(state: string | null | undefined) {
  return !!state && PENDING_STATES.has(state.toUpperCase())
}

export function deploymentStateLabel(state: string | null | undefined) {
  switch (state?.toUpperCase()) {
    case 'STATE_COMPLETED':
      return 'completed'
    case 'STATE_RUNNING':
    case 'STATE_INITIALIZED':
      return 'still running'
    case 'STATE_DEFERRED':
      return 'deferred until the targets are available'
    case 'STATE_FAILED':
      return 'failed'
    default:
      return state ?? null
  }
}

// The budget is wall-clock time, including the progress reads, so a slow AdminServer cannot stretch
// it. A progress read that fails is not a failed deployment: WebLogic already accepted the work
// (the object may even be gone because it finished), so the last known state is returned with a
// note instead of an error.
export async function settleDeploymentProgress(
  initial: unknown,
  fetchProgress: (progressName: string) => Promise<unknown>,
  options: { pollMs?: number; maxWaitMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<unknown> {
  const pollMs = options.pollMs ?? DEPLOYMENT_PROGRESS_POLL_MS
  const maxWaitMs = options.maxWaitMs ?? DEPLOYMENT_PROGRESS_MAX_WAIT_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const name = isObject(initial) && typeof initial.name === 'string' ? initial.name : null
  const deadline = now() + maxWaitMs

  let latest = initial
  while (name && deploymentProgressPending(deploymentProgressState(latest)) && now() < deadline) {
    await sleep(pollMs)
    try {
      latest = await fetchProgress(name)
    } catch (error) {
      return withProgressNote(latest, `Cockpit could not keep following the progress: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return latest
}

function withProgressNote(progress: unknown, note: string) {
  if (!isObject(progress)) return progress
  const existing = progress.messages ?? progress.deploymentMessages
  const messages = Array.isArray(existing) ? existing.filter((message) => typeof message === 'string') : []
  return { ...progress, messages: [...messages, note] }
}
