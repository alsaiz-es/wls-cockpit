import { createClient12, createClient14, type WlsCredentials } from '@/api/client'
import { createWlsHttpError, withWlsRestTimeout } from '@/api/wls-errors'
import { runInEditSession } from './edit-session-transaction'
import type { DeploymentTargetRef } from './deployments'
import { deploymentTargetLabel, deploymentTargetTuple } from './deployment-targets'
import {
  dataSourceParamsBody,
  driverBody,
  gateDataSourceConfigInputForVersion,
  poolBody,
  type DataSourceConfigInput,
} from './data-source-management-payload.ts'

export type DataSourceConfigAction = 'create' | 'edit' | 'targets' | 'delete'
export type { DataSourceConfigInput } from './data-source-management-payload.ts'
export {
  dataSourceParamsBody,
  dataSourceVersionSupportsInvokeBeginEndRequest,
  driverBody,
  gateDataSourceConfigInputForVersion,
  poolBody,
} from './data-source-management-payload.ts'

export interface DataSourceConfigResult {
  action: DataSourceConfigAction
  dataSourceName: string
  targets: DeploymentTargetRef[]
  detail: string
}

const DATA_SOURCE_CONFIG_TIMEOUT_MS = 60_000

function clientFor(creds: WlsCredentials) {
  return creds.version === '14.1.2.0.0' ? createClient14(creds) : createClient12(creds)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readItems(data: unknown): unknown[] {
  return isObject(data) && Array.isArray(data.items) ? data.items : []
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function targetText(targets: DeploymentTargetRef[]) {
  return targets.length ? targets.map(deploymentTargetLabel).join(', ') : 'no targets'
}

function resultDetail(action: DataSourceConfigAction, dataSourceName: string, targets: DeploymentTargetRef[]) {
  if (action === 'create') return `Create ${dataSourceName} on ${targetText(targets)}`
  if (action === 'edit') return `Edit ${dataSourceName}`
  if (action === 'targets') return `Targets ${dataSourceName}: ${targetText(targets)}`
  return `Delete ${dataSourceName}`
}

function configResult(
  action: DataSourceConfigAction,
  dataSourceName: string,
  targets: DeploymentTargetRef[] = [],
): DataSourceConfigResult {
  return {
    action,
    dataSourceName,
    targets,
    detail: resultDetail(action, dataSourceName, targets),
  }
}

async function editRequest(
  label: string,
  request: (signal: AbortSignal) => Promise<{ error?: unknown; response: Response; data?: unknown }>,
  options: { acceptInitialCreate400?: boolean } = {},
) {
  const res = await withWlsRestTimeout(label, request, DATA_SOURCE_CONFIG_TIMEOUT_MS)
  if (res.error && !(options.acceptInitialCreate400 && res.response.status === 400)) {
    throw createWlsHttpError(label, res.response, res.error)
  }
  return res.data
}

async function startEdit(creds: WlsCredentials) {
  await editRequest('Start edit session', (signal) =>
    clientFor(creds).POST('/management/weblogic/{version}/edit/changeManager/startEdit', {
      signal,
      params: {
        path: { version: creds.version },
        header: { 'X-Requested-By': 'wls-cockpit' },
      },
      body: {},
    }),
  )
}

async function activateEdit(creds: WlsCredentials) {
  await editRequest('Activate edit session', (signal) =>
    clientFor(creds).POST('/management/weblogic/{version}/edit/changeManager/activate', {
      signal,
      params: {
        path: { version: creds.version },
        header: { 'X-Requested-By': 'wls-cockpit' },
      },
      body: {},
    }),
  )
}

async function cancelEdit(creds: WlsCredentials) {
  await editRequest('Cancel edit session', (signal) =>
    clientFor(creds).POST('/management/weblogic/{version}/edit/changeManager/cancelEdit', {
      signal,
      params: {
        path: { version: creds.version },
        header: { 'X-Requested-By': 'wls-cockpit' },
      },
      body: {},
    }),
  )
}

async function withEditSession<T>(creds: WlsCredentials, mutation: () => Promise<T>): Promise<T> {
  return runInEditSession(
    {
      startEdit: () => startEdit(creds),
      activate: () => activateEdit(creds),
      cancelEdit: () => cancelEdit(creds),
    },
    mutation,
  )
}

function requireText(value: string, label: string) {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required.`)
  return normalized
}

function requireTargets(targets: DeploymentTargetRef[]) {
  if (targets.length === 0) throw new Error('At least one target is required.')
}

async function upsertUserProperty(creds: WlsCredentials, dataSourceName: string, databaseUser: string) {
  const user = databaseUser.trim()
  if (!user) return

  const properties = await editRequest(`Read user property ${dataSourceName}`, (signal) =>
    clientFor(creds).GET(
      '/management/weblogic/{version}/edit/JDBCSystemResources/{systemResourceName}/JDBCResource/JDBCDriverParams/properties/properties',
      {
        signal,
        params: {
          path: { version: creds.version, systemResourceName: dataSourceName },
          query: { fields: 'name,value', links: 'none' },
        },
      },
    ),
  )
  const hasUserProperty = readItems(properties).some((item) => isObject(item) && readString(item.name) === 'user')
  const client = clientFor(creds)

  if (hasUserProperty) {
    await editRequest(`Update user property ${dataSourceName}`, (signal) =>
      client.POST(
        '/management/weblogic/{version}/edit/JDBCSystemResources/{systemResourceName}/JDBCResource/JDBCDriverParams/properties/properties/{propertieName}',
        {
          signal,
          params: {
            path: { version: creds.version, systemResourceName: dataSourceName, propertieName: 'user' },
            header: { 'X-Requested-By': 'wls-cockpit' },
          },
          body: { value: user },
        },
      ),
    )
    return
  }

  await editRequest(`Create user property ${dataSourceName}`, (signal) =>
    client.POST(
      '/management/weblogic/{version}/edit/JDBCSystemResources/{systemResourceName}/JDBCResource/JDBCDriverParams/properties/properties',
      {
        signal,
        params: {
          path: { version: creds.version, systemResourceName: dataSourceName },
          header: { 'X-Requested-By': 'wls-cockpit' },
        },
        body: { name: 'user', value: user },
      },
    ),
  )
}

async function updateTargets(creds: WlsCredentials, dataSourceName: string, targets: DeploymentTargetRef[]) {
  await editRequest(`Update datasource targets ${dataSourceName}`, (signal) =>
    clientFor(creds).POST('/management/weblogic/{version}/edit/JDBCSystemResources/{systemResourceName}', {
      signal,
      params: {
        path: { version: creds.version, systemResourceName: dataSourceName },
        header: { 'X-Requested-By': 'wls-cockpit' },
      },
      body: {
        targets: targets.map(deploymentTargetTuple),
      } as never,
    }),
  )
}

export async function createDataSource(
  creds: WlsCredentials,
  input: DataSourceConfigInput,
): Promise<DataSourceConfigResult> {
  const name = requireText(input.name, 'Datasource name')
  requireText(input.jndiName, 'JNDI name')
  requireText(input.driverName, 'Driver class')
  requireText(input.url, 'JDBC URL')
  requireTargets(input.targets)
  const gatedInput = gateDataSourceConfigInputForVersion(input, creds)

  return withEditSession(creds, async () => {
    await editRequest(
      `Create datasource ${name}`,
      (signal) =>
        clientFor(creds).POST('/management/weblogic/{version}/edit/JDBCSystemResources', {
          signal,
          params: {
            path: { version: creds.version },
            header: { 'X-Requested-By': 'wls-cockpit' },
          },
          body: { name },
        }),
      { acceptInitialCreate400: true },
    )
    await editRequest(`Initialize datasource ${name}`, (signal) =>
      clientFor(creds).POST('/management/weblogic/{version}/edit/JDBCSystemResources/{systemResourceName}/JDBCResource', {
        signal,
        params: {
          path: { version: creds.version, systemResourceName: name },
          header: { 'X-Requested-By': 'wls-cockpit' },
        },
        body: { name } as never,
      }),
    )
    await editRequest(`Set datasource JNDI ${name}`, (signal) =>
      clientFor(creds).POST(
        '/management/weblogic/{version}/edit/JDBCSystemResources/{systemResourceName}/JDBCResource/JDBCDataSourceParams',
        {
          signal,
          params: {
            path: { version: creds.version, systemResourceName: name },
            header: { 'X-Requested-By': 'wls-cockpit' },
          },
          body: dataSourceParamsBody(gatedInput),
        },
      ),
    )
    await editRequest(`Set datasource driver ${name}`, (signal) =>
      clientFor(creds).POST(
        '/management/weblogic/{version}/edit/JDBCSystemResources/{systemResourceName}/JDBCResource/JDBCDriverParams',
        {
          signal,
          params: {
            path: { version: creds.version, systemResourceName: name },
            header: { 'X-Requested-By': 'wls-cockpit' },
          },
          body: driverBody(gatedInput),
        },
      ),
    )
    await upsertUserProperty(creds, name, gatedInput.databaseUser)
    const pool = poolBody(gatedInput)
    if (Object.keys(pool).length) {
      await editRequest(`Set datasource pool ${name}`, (signal) =>
        clientFor(creds).POST(
          '/management/weblogic/{version}/edit/JDBCSystemResources/{systemResourceName}/JDBCResource/JDBCConnectionPoolParams',
          {
            signal,
            params: {
              path: { version: creds.version, systemResourceName: name },
              header: { 'X-Requested-By': 'wls-cockpit' },
            },
            body: pool,
          },
        ),
      )
    }
    await updateTargets(creds, name, input.targets)
    return configResult('create', name, input.targets)
  })
}

export async function updateDataSource(
  creds: WlsCredentials,
  dataSourceName: string,
  input: DataSourceConfigInput,
): Promise<DataSourceConfigResult> {
  const name = requireText(dataSourceName, 'Datasource name')
  requireText(input.jndiName, 'JNDI name')
  requireText(input.driverName, 'Driver class')
  requireText(input.url, 'JDBC URL')
  const gatedInput = gateDataSourceConfigInputForVersion(input, creds)

  return withEditSession(creds, async () => {
    await editRequest(`Update datasource JNDI ${name}`, (signal) =>
      clientFor(creds).POST(
        '/management/weblogic/{version}/edit/JDBCSystemResources/{systemResourceName}/JDBCResource/JDBCDataSourceParams',
        {
          signal,
          params: {
            path: { version: creds.version, systemResourceName: name },
            header: { 'X-Requested-By': 'wls-cockpit' },
          },
          body: dataSourceParamsBody(gatedInput),
        },
      ),
    )
    await editRequest(`Update datasource driver ${name}`, (signal) =>
      clientFor(creds).POST(
        '/management/weblogic/{version}/edit/JDBCSystemResources/{systemResourceName}/JDBCResource/JDBCDriverParams',
        {
          signal,
          params: {
            path: { version: creds.version, systemResourceName: name },
            header: { 'X-Requested-By': 'wls-cockpit' },
          },
          body: driverBody(gatedInput),
        },
      ),
    )
    await upsertUserProperty(creds, name, gatedInput.databaseUser)
    const pool = poolBody(gatedInput)
    if (Object.keys(pool).length) {
      await editRequest(`Update datasource pool ${name}`, (signal) =>
        clientFor(creds).POST(
          '/management/weblogic/{version}/edit/JDBCSystemResources/{systemResourceName}/JDBCResource/JDBCConnectionPoolParams',
          {
            signal,
            params: {
              path: { version: creds.version, systemResourceName: name },
              header: { 'X-Requested-By': 'wls-cockpit' },
            },
            body: pool,
          },
        ),
      )
    }
    return configResult('edit', name)
  })
}

export async function updateDataSourceTargets(
  creds: WlsCredentials,
  dataSourceName: string,
  targets: DeploymentTargetRef[],
): Promise<DataSourceConfigResult> {
  const name = requireText(dataSourceName, 'Datasource name')
  requireTargets(targets)

  return withEditSession(creds, async () => {
    await updateTargets(creds, name, targets)
    return configResult('targets', name, targets)
  })
}

export async function deleteDataSource(
  creds: WlsCredentials,
  dataSourceName: string,
): Promise<DataSourceConfigResult> {
  const name = requireText(dataSourceName, 'Datasource name')

  return withEditSession(creds, async () => {
    await editRequest(`Delete datasource ${name}`, (signal) =>
      clientFor(creds).DELETE('/management/weblogic/{version}/edit/JDBCSystemResources/{systemResourceName}', {
        signal,
        params: {
          path: { version: creds.version, systemResourceName: name },
          header: { 'X-Requested-By': 'wls-cockpit' },
        },
      }),
    )
    return configResult('delete', name)
  })
}

export function coerceConfigNumber(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const number = Number(trimmed)
  return Number.isFinite(number) ? number : null
}

export function configNumberValue(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

export function readDataSourceConfigNumber(value: unknown): number | null {
  return readNumber(value)
}
