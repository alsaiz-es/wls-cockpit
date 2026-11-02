export type OptionalFamilyStatus = 'available' | 'empty' | 'failed'

export interface FamilyFailure {
  resource: string
  message: string
}

export interface OptionalFamilyPayload<T> {
  attempted: number
  successful: number
  items: T[]
  failures: FamilyFailure[]
}

export interface OptionalFamilyResult<T> {
  status: OptionalFamilyStatus
  items: T[]
  error?: string
  failures?: FamilyFailure[]
}

export interface FamilyPartialFailure<Family extends string> {
  family: Family
  resource?: string
  message: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function dashboardFanoutErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown error'
}

function isOptionalFamilyPayload<T>(value: T[] | OptionalFamilyPayload<T>): value is OptionalFamilyPayload<T> {
  return isObject(value) && Array.isArray(value.items) && Array.isArray(value.failures)
}

export async function collectDashboardFamilyFanout<T, R>(
  resources: readonly R[],
  fetchResource: (resource: R) => Promise<T[] | OptionalFamilyPayload<T>>,
  resourceName: (resource: R) => string,
): Promise<OptionalFamilyPayload<T>> {
  const outcomes = await Promise.allSettled(resources.map(fetchResource))

  return outcomes.reduce<OptionalFamilyPayload<T>>(
    (payload, outcome, index) => {
      if (outcome.status === 'rejected') {
        payload.failures.push({
          resource: resourceName(resources[index]),
          message: dashboardFanoutErrorMessage(outcome.reason),
        })
        return payload
      }

      if (isOptionalFamilyPayload(outcome.value)) {
        payload.successful += outcome.value.successful
        payload.items.push(...outcome.value.items)
        payload.failures.push(...outcome.value.failures)
        return payload
      }

      payload.successful += 1
      payload.items.push(...outcome.value)
      return payload
    },
    { attempted: resources.length, successful: 0, items: [], failures: [] },
  )
}

export function toDashboardFamilyResult<T, Family extends string>(
  family: Family,
  payloadOrItems: T[] | OptionalFamilyPayload<T>,
): OptionalFamilyResult<T> {
  const payload = isOptionalFamilyPayload(payloadOrItems)
    ? payloadOrItems
    : { attempted: 0, successful: 1, items: payloadOrItems, failures: [] }
  const status =
    payload.items.length === 0 && payload.failures.length > 0 && payload.successful === 0 && payload.attempted > 0
      ? 'failed'
      : payload.items.length > 0
        ? 'available'
        : 'empty'
  const failures = payload.failures.length > 0 ? payload.failures : undefined
  const error = failures
    ? `${family}: ${failures.map((failure) => `${failure.resource}: ${failure.message}`).join('; ')}`
    : undefined

  return { status, items: payload.items, error, failures }
}

export function dashboardPartialFailures<Family extends string>(
  families: Array<{ family: Family; result: OptionalFamilyResult<unknown> }>,
): Array<FamilyPartialFailure<Family>> {
  return families.flatMap(({ family, result }) =>
    (result.failures ?? []).map((failure) => ({
      family,
      resource: failure.resource,
      message: `${family} ${failure.resource}: ${failure.message}`,
    })),
  )
}
