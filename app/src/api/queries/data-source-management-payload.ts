import type { DeploymentTargetRef } from './deployments.ts'

export interface DataSourceConfigInput {
  name: string
  jndiName: string
  driverName: string
  url: string
  databaseUser: string
  password: string
  globalTransactionsProtocol: string | null
  useXaDataSourceInterface: boolean | null
  keepConnAfterGlobalTx: boolean | null
  initialCapacity: number | null
  minCapacity: number | null
  maxCapacity: number | null
  testTableName: string
  testConnectionsOnReserve: boolean | null
  testFrequencySeconds: number | null
  secondsToTrustAnIdlePoolConnection: number | null
  countOfTestFailuresTillFlush: number | null
  countOfRefreshFailuresTillDisable: number | null
  statementCacheSize: number | null
  statementCacheType: string | null
  statementTimeout: number | null
  shrinkFrequencySeconds: number | null
  inactiveConnectionTimeoutSeconds: number | null
  connectionReserveTimeoutSeconds: number | null
  connectionCreationRetryFrequencySeconds: number | null
  loginDelaySeconds: number | null
  highestNumWaiters: number | null
  removeInfectedConnections: boolean | null
  pinnedToThread: boolean | null
  wrapJdbc: boolean | null
  wrapTypes: boolean | null
  invokeBeginEndRequest: boolean | null
  targets: DeploymentTargetRef[]
}

function definedFields(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null && value !== ''))
}

export function poolBody(input: DataSourceConfigInput) {
  return definedFields({
    initialCapacity: input.initialCapacity,
    minCapacity: input.minCapacity,
    maxCapacity: input.maxCapacity,
    testTableName: input.testTableName.trim(),
    testConnectionsOnReserve: input.testConnectionsOnReserve,
    testFrequencySeconds: input.testFrequencySeconds,
    secondsToTrustAnIdlePoolConnection: input.secondsToTrustAnIdlePoolConnection,
    countOfTestFailuresTillFlush: input.countOfTestFailuresTillFlush,
    countOfRefreshFailuresTillDisable: input.countOfRefreshFailuresTillDisable,
    statementCacheSize: input.statementCacheSize,
    statementCacheType: input.statementCacheType,
    statementTimeout: input.statementTimeout,
    shrinkFrequencySeconds: input.shrinkFrequencySeconds,
    inactiveConnectionTimeoutSeconds: input.inactiveConnectionTimeoutSeconds,
    connectionReserveTimeoutSeconds: input.connectionReserveTimeoutSeconds,
    connectionCreationRetryFrequencySeconds: input.connectionCreationRetryFrequencySeconds,
    loginDelaySeconds: input.loginDelaySeconds,
    highestNumWaiters: input.highestNumWaiters,
    removeInfectedConnections: input.removeInfectedConnections,
    pinnedToThread: input.pinnedToThread,
    wrapJdbc: input.wrapJdbc,
    wrapTypes: input.wrapTypes,
    invokeBeginEndRequest: input.invokeBeginEndRequest,
  })
}

export function driverBody(input: DataSourceConfigInput) {
  return definedFields({
    driverName: input.driverName.trim(),
    url: input.url.trim(),
    password: input.password.trim(),
    useXaDataSourceInterface: input.useXaDataSourceInterface,
  })
}

export function dataSourceParamsBody(input: DataSourceConfigInput) {
  return definedFields({
    JNDINames: [input.jndiName.trim()],
    globalTransactionsProtocol: input.globalTransactionsProtocol,
    keepConnAfterGlobalTx: input.keepConnAfterGlobalTx,
  })
}

export function dataSourceVersionSupportsInvokeBeginEndRequest(creds: { version: string }) {
  return creds.version === '14.1.2.0.0'
}

export function gateDataSourceConfigInputForVersion(
  input: DataSourceConfigInput,
  creds: { version: string },
): DataSourceConfigInput {
  return dataSourceVersionSupportsInvokeBeginEndRequest(creds)
    ? input
    : { ...input, invokeBeginEndRequest: null }
}
