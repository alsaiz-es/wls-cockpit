import type { DataTableSort, SortDirection } from '@/components'

export type RuntimeTableFilterValue = string | boolean

export interface RuntimeTableFilterConfig {
  param: string
  defaultValue: RuntimeTableFilterValue
  allowedValues?: readonly string[]
}

export interface RuntimeTableUrlConfig {
  defaultSort: DataTableSort
  sortableColumns: readonly string[]
  searchParam?: string
  filters: Record<string, RuntimeTableFilterConfig>
}

export interface RuntimeTableUrlState {
  search: string
  filters: Record<string, RuntimeTableFilterValue>
  sort: DataTableSort | null
}

const SORT_PARAM = 'sort'
const DIRECTION_PARAM = 'dir'

function searchParamName(config: RuntimeTableUrlConfig) {
  return config.searchParam ?? 'q'
}

function validDirection(value: string | null): SortDirection | null {
  return value === 'asc' || value === 'desc' ? value : null
}

function normalizeString(value: string | null) {
  const trimmed = value?.trim() ?? ''
  return trimmed.length ? trimmed : null
}

function parseFilter(params: URLSearchParams, filter: RuntimeTableFilterConfig) {
  if (typeof filter.defaultValue === 'boolean') {
    const raw = params.get(filter.param)
    if (raw === '1' || raw === 'true') return true
    if (raw === '0' || raw === 'false') return false
    return filter.defaultValue
  }

  const raw = normalizeString(params.get(filter.param))
  if (!raw) return filter.defaultValue
  if (filter.allowedValues && !filter.allowedValues.includes(raw)) return filter.defaultValue
  return raw
}

function parseSort(params: URLSearchParams, config: RuntimeTableUrlConfig) {
  const columnId = normalizeString(params.get(SORT_PARAM))
  const direction = validDirection(params.get(DIRECTION_PARAM))
  if (!columnId || !direction) return null
  if (!config.sortableColumns.includes(columnId)) return null
  if (columnId === config.defaultSort.columnId && direction === config.defaultSort.direction) return null
  return { columnId, direction }
}

export function parseRuntimeTableUrlState(
  params: URLSearchParams,
  config: RuntimeTableUrlConfig,
): RuntimeTableUrlState {
  return {
    search: normalizeString(params.get(searchParamName(config))) ?? '',
    filters: Object.fromEntries(
      Object.entries(config.filters).map(([key, filter]) => [key, parseFilter(params, filter)]),
    ),
    sort: parseSort(params, config),
  }
}

function writeFilter(params: URLSearchParams, filter: RuntimeTableFilterConfig, value: RuntimeTableFilterValue) {
  params.delete(filter.param)
  if (typeof filter.defaultValue === 'boolean') {
    if (value === true && filter.defaultValue === false) params.set(filter.param, '1')
    if (value === false && filter.defaultValue === true) params.set(filter.param, '0')
    return
  }

  if (typeof value === 'string' && value !== filter.defaultValue && value.trim().length > 0) {
    params.set(filter.param, value)
  }
}

export function serializeRuntimeTableUrlState(
  state: RuntimeTableUrlState,
  config: RuntimeTableUrlConfig,
  baseParams: URLSearchParams = new URLSearchParams(),
) {
  const params = new URLSearchParams(baseParams)
  const q = searchParamName(config)
  params.delete(q)
  params.delete(SORT_PARAM)
  params.delete(DIRECTION_PARAM)
  Object.values(config.filters).forEach((filter) => params.delete(filter.param))

  const search = state.search.trim()
  if (search.length > 0) params.set(q, search)

  Object.entries(config.filters).forEach(([key, filter]) => {
    writeFilter(params, filter, state.filters[key] ?? filter.defaultValue)
  })

  const sort = state.sort
  if (
    sort &&
    config.sortableColumns.includes(sort.columnId) &&
    (sort.columnId !== config.defaultSort.columnId || sort.direction !== config.defaultSort.direction)
  ) {
    params.set(SORT_PARAM, sort.columnId)
    params.set(DIRECTION_PARAM, sort.direction)
  }

  return params
}
