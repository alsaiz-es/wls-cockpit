export interface DetailReturnState {
  returnTo: string
}

export function detailReturnState(location: { pathname: string; search: string }): DetailReturnState {
  return {
    returnTo: `${location.pathname}${location.search}`,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isAllowedReturnPath(value: string, fallbackPath: string) {
  return (
    value === fallbackPath ||
    value.startsWith(`${fallbackPath}?`) ||
    value.startsWith(`${fallbackPath}#`)
  )
}

export function detailReturnPath(state: unknown, fallbackPath: string) {
  if (!isObject(state)) return fallbackPath
  const value = state.returnTo
  if (typeof value !== 'string') return fallbackPath
  return isAllowedReturnPath(value, fallbackPath) ? value : fallbackPath
}
