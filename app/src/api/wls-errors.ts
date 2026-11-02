export const WLS_REST_TIMEOUT_MS = 15_000

export type WlsRestErrorKind = 'http' | 'timeout' | 'transport'

export class WlsRestError extends Error {
  kind: WlsRestErrorKind
  operation: string
  status: number | null
  statusText: string | null

  constructor({
    kind,
    operation,
    status = null,
    statusText = null,
    message,
    cause,
  }: {
    kind: WlsRestErrorKind
    operation: string
    status?: number | null
    statusText?: string | null
    message: string
    cause?: unknown
  }) {
    super(message, { cause })
    this.name = 'WlsRestError'
    this.kind = kind
    this.operation = operation
    this.status = status
    this.statusText = statusText
  }
}

export function isWlsRestError(error: unknown): error is WlsRestError {
  return error instanceof WlsRestError
}

const WLS_DETAIL_MAX_LENGTH = 300

function textField(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

// WebLogic puts the reason for a rejected request in `detail` (or in `wls:errorsDetails` for edit
// tree validation), often behind a chain of Java exception class names.
export function wlsErrorDetail(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const record = body as Record<string, unknown>
  const nested = Array.isArray(record['wls:errorsDetails']) ? record['wls:errorsDetails'][0] : null
  const raw =
    textField(record.detail) ??
    (typeof nested === 'object' && nested !== null ? textField((nested as Record<string, unknown>).detail) : null)
  if (!raw) return null
  const detail = raw.replace(/^(?:[\w.$]+(?:Exception|Error):\s*)+/, '').trim() || raw
  return detail.length > WLS_DETAIL_MAX_LENGTH ? `${detail.slice(0, WLS_DETAIL_MAX_LENGTH - 1)}…` : detail
}

export function createWlsHttpError(operation: string, response: Response, body?: unknown) {
  const statusText = response.statusText || 'HTTP error'
  const detail = wlsErrorDetail(body)
  const base =
    response.status === 401
      ? `${operation}: authentication failed (HTTP 401 ${statusText})`
      : `${operation}: HTTP ${response.status} ${statusText}`
  const message = detail ? `${base}: ${detail}` : base

  return new WlsRestError({
    kind: 'http',
    operation,
    status: response.status,
    statusText,
    message,
  })
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function errorDetail(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  return 'Unknown error'
}

export function normalizeWlsRestError(operation: string, error: unknown, timeoutMs = WLS_REST_TIMEOUT_MS) {
  if (isWlsRestError(error)) return error

  if (isAbortError(error)) {
    return new WlsRestError({
      kind: 'timeout',
      operation,
      message: `${operation}: timed out after ${Math.round(timeoutMs / 1000)}s`,
      cause: error,
    })
  }

  return new WlsRestError({
    kind: 'transport',
    operation,
    message: `${operation}: ${errorDetail(error)}`,
    cause: error,
  })
}

export async function withWlsRestTimeout<T>(
  operation: string,
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs = WLS_REST_TIMEOUT_MS,
) {
  const controller = new AbortController()
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await run(controller.signal)
  } catch (error) {
    throw normalizeWlsRestError(operation, error, timeoutMs)
  } finally {
    globalThis.clearTimeout(timeout)
  }
}
