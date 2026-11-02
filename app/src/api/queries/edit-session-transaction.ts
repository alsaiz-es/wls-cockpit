import { isWlsRestError, WlsRestError } from '../wls-errors.ts'

export interface EditSessionSteps {
  startEdit: () => Promise<unknown>
  activate: () => Promise<unknown>
  cancelEdit: () => Promise<unknown>
}

// WebLogic answered with an HTTP error: the request was refused, so no lock was taken. Anything
// else (client-side timeout, connection reset) may have reached WebLogic.
function startEditOutcomeUnknown(error: unknown) {
  return !(isWlsRestError(error) && error.kind === 'http')
}

// startEdit -> mutation -> activate, cancelling on failure. A startEdit that times out on the
// client may still have taken the edit lock on the AdminServer; it is cancelled too, otherwise
// the lock is left behind and blocks every later change until it expires.
export async function runInEditSession<T>(steps: EditSessionSteps, mutation: () => Promise<T>): Promise<T> {
  try {
    await steps.startEdit()
  } catch (error) {
    if (startEditOutcomeUnknown(error)) await steps.cancelEdit().catch(() => undefined)
    throw error
  }

  let result: T
  try {
    result = await mutation()
  } catch (error) {
    await steps.cancelEdit().catch(() => undefined)
    throw error
  }

  try {
    await steps.activate()
    return result
  } catch (error) {
    await steps.cancelEdit().catch(() => undefined)
    if (!startEditOutcomeUnknown(error)) throw error
    // No answer is not a refusal: the AdminServer may have activated the change after the client
    // gave up, so it is reported as uncertain instead of as a failure.
    const operation = isWlsRestError(error) ? error.operation : 'Activate changes'
    throw new WlsRestError({
      kind: isWlsRestError(error) ? error.kind : 'transport',
      operation,
      message: `${operation}: WebLogic did not answer while activating; the change may have been applied. Check the configuration and the Action Audit before retrying.`,
    })
  }
}
