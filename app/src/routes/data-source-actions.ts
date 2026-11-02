import type { DataSourceLifecycleAction } from '@/api/queries/data-source-lifecycle'

export interface DataSourceActionInput {
  state: string
  runtimeAvailable: boolean
  configurationSupported: boolean
  systemResourceName: string | null
}

export interface DataSourceActionModeOptions {
  readOnlyDemoMode?: boolean
}

function normalizedState(row: Pick<DataSourceActionInput, 'state'>) {
  return row.state.trim().toLowerCase()
}

export function canMutateDataSourceConfig(
  row: DataSourceActionInput,
  options: DataSourceActionModeOptions = {},
) {
  return !options.readOnlyDemoMode && row.configurationSupported && !!row.systemResourceName
}

export function dataSourceRowActions(
  row: Pick<DataSourceActionInput, 'state' | 'runtimeAvailable'>,
  options: DataSourceActionModeOptions = {},
): DataSourceLifecycleAction[] {
  if (options.readOnlyDemoMode) return []
  if (!row.runtimeAvailable) return []
  const state = normalizedState(row)
  const actions: DataSourceLifecycleAction[] = ['testPool']

  if (state === 'running') actions.push('suspend')
  if (state === 'suspended') actions.push('resume')

  actions.push('shrink', 'reset', 'clearStatementCache')
  return actions
}
