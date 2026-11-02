import type { DeploymentTargetRef } from './deployments'

export interface DataSourceParamsMetadata {
  jndiNames: string[]
  globalTransactionsProtocol: string | null
  algorithmType: string | null
  scope: string | null
  dataSourceList: string | null
  keepConnAfterGlobalTx: boolean | null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => (readString(item) ? [readString(item) as string] : [])) : []
}

export function readDataSourceTargetRefs(value: unknown): DeploymentTargetRef[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const identity = Array.isArray(item) ? item : isObject(item) ? item.identity : null
    if (!Array.isArray(identity)) return []
    const kind = readString(identity[0])
    const name = readString(identity[1])
    if ((kind === 'servers' || kind === 'clusters') && name) return [{ kind, name }]
    return []
  })
}

export function normalizeDataSourceParamsMetadata(value: unknown): DataSourceParamsMetadata {
  const data = isObject(value) ? value : {}
  return {
    jndiNames: readStringArray(data.JNDINames),
    globalTransactionsProtocol: readString(data.globalTransactionsProtocol),
    algorithmType: readString(data.algorithmType),
    scope: readString(data.scope),
    dataSourceList: readString(data.dataSourceList),
    keepConnAfterGlobalTx: readBoolean(data.keepConnAfterGlobalTx),
  }
}

export function dataSourceParamsQueryParams() {
  return {
    fields: 'JNDINames,globalTransactionsProtocol,algorithmType,scope,dataSourceList,keepConnAfterGlobalTx',
    links: 'none',
  } as const
}

export function dataSourceConfigCollectionQueryParams() {
  return {
    fields: 'name,targets',
    links: 'none',
  } as const
}
