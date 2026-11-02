import {
  dataSourceDriverPreset,
  defaultUrlTemplateFields,
  deriveDataSourceUrl,
  matchDataSourceDriverPreset,
  parseDataSourcePresetUrl,
  type DataSourceDriverPresetId,
  type DataSourceTransactionProtocol,
  type DataSourceUrlMode,
} from '../api/queries/data-source-driver-presets.ts'
import type { DataSourceRuntimeRow } from '../api/queries/data-sources.ts'

export type BooleanFormValue = 'default' | 'true' | 'false'
export type StatementCacheTypeFormValue = '' | 'LRU' | 'FIXED'

export interface DataSourceConfigFormState {
  name: string
  jndiName: string
  driverPresetId: DataSourceDriverPresetId
  urlMode: DataSourceUrlMode
  urlTemplateFields: Record<string, string>
  driverName: string
  url: string
  databaseUser: string
  password: string
  initialCapacity: string
  minCapacity: string
  maxCapacity: string
  testTableName: string
  globalTransactionsProtocol: DataSourceTransactionProtocol
  useXaDataSourceInterface: BooleanFormValue
  keepConnAfterGlobalTx: BooleanFormValue
  testConnectionsOnReserve: BooleanFormValue
  testFrequencySeconds: string
  secondsToTrustAnIdlePoolConnection: string
  countOfTestFailuresTillFlush: string
  countOfRefreshFailuresTillDisable: string
  statementCacheSize: string
  statementCacheType: StatementCacheTypeFormValue
  statementTimeout: string
  shrinkFrequencySeconds: string
  inactiveConnectionTimeoutSeconds: string
  connectionReserveTimeoutSeconds: string
  connectionCreationRetryFrequencySeconds: string
  loginDelaySeconds: string
  highestNumWaiters: string
  removeInfectedConnections: BooleanFormValue
  pinnedToThread: BooleanFormValue
  wrapJdbc: BooleanFormValue
  wrapTypes: BooleanFormValue
  invokeBeginEndRequest: BooleanFormValue
  targetKeys: string[]
}

export interface DataSourceConfigValidationResult {
  valid: boolean
  errors: Partial<Record<keyof DataSourceConfigFormState | 'targets', string>>
}

const NUMBER_FIELDS: Array<keyof DataSourceConfigFormState> = [
  'initialCapacity',
  'minCapacity',
  'maxCapacity',
  'testFrequencySeconds',
  'secondsToTrustAnIdlePoolConnection',
  'countOfTestFailuresTillFlush',
  'countOfRefreshFailuresTillDisable',
  'statementCacheSize',
  'statementTimeout',
  'shrinkFrequencySeconds',
  'inactiveConnectionTimeoutSeconds',
  'connectionReserveTimeoutSeconds',
  'connectionCreationRetryFrequencySeconds',
  'loginDelaySeconds',
  'highestNumWaiters',
]

function configNumberValue(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

function targetKey(target: { kind: string; name: string }) {
  return `${target.kind}:${target.name}`
}

function booleanValue(value: boolean | null | undefined): BooleanFormValue {
  if (value === true) return 'true'
  if (value === false) return 'false'
  return 'default'
}

export function formBooleanValue(value: BooleanFormValue): boolean | null {
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

export function initialConfigForm(targetKeys: string[] = []): DataSourceConfigFormState {
  const preset = dataSourceDriverPreset('oracle-thin-service')
  const templateFields = defaultUrlTemplateFields(preset)
  return {
    name: '',
    jndiName: '',
    driverPresetId: preset.id,
    urlMode: 'template',
    urlTemplateFields: templateFields,
    driverName: preset.driverName,
    url: deriveDataSourceUrl(preset.id, templateFields),
    databaseUser: '',
    password: '',
    initialCapacity: '',
    minCapacity: '',
    maxCapacity: '',
    testTableName: preset.defaultTestTableName,
    globalTransactionsProtocol: preset.globalTransactionsProtocol,
    useXaDataSourceInterface: booleanValue(preset.useXaDataSourceInterface),
    keepConnAfterGlobalTx: 'default',
    testConnectionsOnReserve: 'default',
    testFrequencySeconds: '',
    secondsToTrustAnIdlePoolConnection: '',
    countOfTestFailuresTillFlush: '',
    countOfRefreshFailuresTillDisable: '',
    statementCacheSize: '',
    statementCacheType: '',
    statementTimeout: '',
    shrinkFrequencySeconds: '',
    inactiveConnectionTimeoutSeconds: '',
    connectionReserveTimeoutSeconds: '',
    connectionCreationRetryFrequencySeconds: '',
    loginDelaySeconds: '',
    highestNumWaiters: '',
    removeInfectedConnections: 'default',
    pinnedToThread: 'default',
    wrapJdbc: 'default',
    wrapTypes: 'default',
    invokeBeginEndRequest: 'default',
    targetKeys,
  }
}

export function formForRow(row: DataSourceRuntimeRow): DataSourceConfigFormState {
  const preset = matchDataSourceDriverPreset(row.driverName, row.url)
  const parsedFields = parseDataSourcePresetUrl(preset.id, row.url)
  const templateFields = parsedFields ?? defaultUrlTemplateFields(preset)
  return {
    ...initialConfigForm(row.configuredTargets.map(targetKey)),
    name: row.systemResourceName ?? row.name,
    jndiName: row.jndiNames[0] ?? row.name,
    driverPresetId: preset.id,
    urlMode: parsedFields ? 'template' : 'manual',
    urlTemplateFields: templateFields,
    driverName: row.driverName ?? preset.driverName,
    url: row.url ?? deriveDataSourceUrl(preset.id, templateFields),
    databaseUser: row.databaseUser ?? '',
    password: '',
    initialCapacity: configNumberValue(row.configuredInitialCapacity),
    minCapacity: configNumberValue(row.configuredMinCapacity),
    maxCapacity: configNumberValue(row.configuredMaxCapacity),
    testTableName: row.testTableName ?? preset.defaultTestTableName,
    globalTransactionsProtocol:
      (row.globalTransactionsProtocol as DataSourceTransactionProtocol | null) ?? preset.globalTransactionsProtocol,
    useXaDataSourceInterface: booleanValue(row.useXaDataSourceInterface ?? preset.useXaDataSourceInterface),
    keepConnAfterGlobalTx: booleanValue(row.keepConnAfterGlobalTx),
    testConnectionsOnReserve: booleanValue(row.testConnectionsOnReserve),
    testFrequencySeconds: configNumberValue(row.testFrequencySeconds),
    secondsToTrustAnIdlePoolConnection: configNumberValue(row.secondsToTrustAnIdlePoolConnection),
    countOfTestFailuresTillFlush: configNumberValue(row.countOfTestFailuresTillFlush),
    countOfRefreshFailuresTillDisable: configNumberValue(row.countOfRefreshFailuresTillDisable),
    statementCacheSize: configNumberValue(row.statementCacheSize),
    statementCacheType: (row.statementCacheType === 'LRU' || row.statementCacheType === 'FIXED') ? row.statementCacheType : '',
    statementTimeout: configNumberValue(row.statementTimeout),
    shrinkFrequencySeconds: configNumberValue(row.shrinkFrequencySeconds),
    inactiveConnectionTimeoutSeconds: configNumberValue(row.inactiveConnectionTimeoutSeconds),
    connectionReserveTimeoutSeconds: configNumberValue(row.connectionReserveTimeoutSeconds),
    connectionCreationRetryFrequencySeconds: configNumberValue(row.connectionCreationRetryFrequencySeconds),
    loginDelaySeconds: configNumberValue(row.loginDelaySeconds),
    highestNumWaiters: configNumberValue(row.highestNumWaiters),
    removeInfectedConnections: booleanValue(row.removeInfectedConnections),
    pinnedToThread: booleanValue(row.pinnedToThread),
    wrapJdbc: booleanValue(row.wrapJdbc),
    wrapTypes: booleanValue(row.wrapTypes),
    invokeBeginEndRequest: booleanValue(row.invokeBeginEndRequest),
  }
}

export function applyDriverPreset(form: DataSourceConfigFormState, presetId: DataSourceDriverPresetId): DataSourceConfigFormState {
  const preset = dataSourceDriverPreset(presetId)
  const urlTemplateFields = defaultUrlTemplateFields(preset)
  const urlMode = preset.id === 'custom' ? 'manual' : form.urlMode
  return {
    ...form,
    driverPresetId: preset.id,
    urlMode,
    urlTemplateFields,
    driverName: preset.driverName || form.driverName,
    url: urlMode === 'template' ? deriveDataSourceUrl(preset.id, urlTemplateFields) : form.url,
    testTableName: form.testTableName || preset.defaultTestTableName,
    globalTransactionsProtocol: preset.globalTransactionsProtocol,
    useXaDataSourceInterface: booleanValue(preset.useXaDataSourceInterface),
  }
}

export function updateUrlMode(form: DataSourceConfigFormState, urlMode: DataSourceUrlMode): DataSourceConfigFormState {
  if (urlMode === form.urlMode) return form
  if (urlMode === 'template') {
    return {
      ...form,
      urlMode,
      url: deriveDataSourceUrl(form.driverPresetId, form.urlTemplateFields),
    }
  }
  return { ...form, urlMode }
}

export function updateUrlTemplateField(
  form: DataSourceConfigFormState,
  field: string,
  value: string,
): DataSourceConfigFormState {
  const urlTemplateFields = { ...form.urlTemplateFields, [field]: value }
  return {
    ...form,
    urlTemplateFields,
    url: form.urlMode === 'template' ? deriveDataSourceUrl(form.driverPresetId, urlTemplateFields) : form.url,
  }
}

function isIntegerText(value: string) {
  if (!value.trim()) return true
  return /^-?\d+$/.test(value.trim())
}

function numberValue(value: string) {
  if (!value.trim() || !isIntegerText(value)) return null
  return Number(value.trim())
}

function requireField(
  errors: DataSourceConfigValidationResult['errors'],
  field: keyof DataSourceConfigFormState,
  value: string,
  label: string,
) {
  if (!value.trim()) errors[field] = `${label} is required.`
}

export function validateDataSourceConfigForm(
  form: DataSourceConfigFormState,
  mode: 'create' | 'edit',
): DataSourceConfigValidationResult {
  const errors: DataSourceConfigValidationResult['errors'] = {}
  if (mode === 'create') requireField(errors, 'name', form.name, 'Datasource name')
  requireField(errors, 'jndiName', form.jndiName, 'JNDI name')
  requireField(errors, 'driverName', form.driverName, 'Driver class')
  requireField(errors, 'databaseUser', form.databaseUser, 'Database user')
  if (form.targetKeys.length === 0) errors.targets = 'At least one target is required.'

  if (form.urlMode === 'template') {
    const preset = dataSourceDriverPreset(form.driverPresetId)
    preset.urlFields.forEach((field) => {
      if (!form.urlTemplateFields[field.id]?.trim()) errors.url = `${field.label} is required to derive the JDBC URL.`
    })
  }
  if (!form.url.trim() || !form.url.trim().toLowerCase().startsWith('jdbc:')) {
    errors.url = 'JDBC URL must start with jdbc:.'
  }

  NUMBER_FIELDS.forEach((field) => {
    const value = String(form[field] ?? '')
    if (!isIntegerText(value)) errors[field] = 'Use an integer value.'
  })

  const initial = numberValue(form.initialCapacity)
  const min = numberValue(form.minCapacity)
  const max = numberValue(form.maxCapacity)
  if (initial !== null && initial < 0) errors.initialCapacity = 'Use zero or a positive integer.'
  if (min !== null && min < 0) errors.minCapacity = 'Use zero or a positive integer.'
  if (max !== null && max < 0) errors.maxCapacity = 'Use zero or a positive integer.'
  if (max !== null && initial !== null && initial > max) errors.initialCapacity = 'Initial capacity cannot exceed max capacity.'
  if (max !== null && min !== null && min > max) errors.minCapacity = 'Min capacity cannot exceed max capacity.'
  if (
    (form.testConnectionsOnReserve === 'true' || form.testFrequencySeconds.trim()) &&
    !form.testTableName.trim()
  ) {
    errors.testTableName = 'A test table or SQL probe is required for connection testing.'
  }

  return { valid: Object.keys(errors).length === 0, errors }
}
