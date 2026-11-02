import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(__dirname, '..')
const REPO_ROOT = resolve(APP_ROOT, '..')
const APP_ENV = resolve(REPO_ROOT, 'app/.env.local')
const PROXY_TARGET_MODULE = resolve(REPO_ROOT, 'app/src/api/proxy-target.ts')
const TIMEOUT_MS = Number(process.env.WLS_DELTA_TIMEOUT_MS ?? '6000')
const OUTPUT = process.env.WLS_DELTA_OUTPUT
  ? resolve(process.env.WLS_DELTA_OUTPUT)
  : resolve(APP_ROOT, 'test-results/rest-delta', `rest-version-delta-${process.env.WLS_DELTA_VERSION ?? 'target'}.sanitized.json`)

const SERVER_LIFECYCLE_FIELDS = 'name,state'
const SERVER_RUNTIME_BASE_FIELDS = 'name,state,healthState,listenAddress,listenPort,defaultURL,restartRequired'
const JVM_RUNTIME_FIELDS =
  'heapFreeCurrent,heapSizeCurrent,heapSizeMax,uptime,javaVersion,javaVendor,javaVMVendor,OSName,OSVersion'
const THREAD_POOL_FIELDS =
  'executeThreadTotalCount,executeThreadIdleCount,standbyThreadCount,pendingUserRequestCount,queueLength,hoggingThreadCount,stuckThreadCount'
const DEPLOYMENT_RUNTIME_FIELDS =
  'name,applicationName,applicationVersion,internal,healthState,overallHealthState,activeVersionState,deploymentState'
const DEPLOYMENT_CONFIG_FIELDS =
  'name,applicationName,targets,moduleType,deploymentOrder,sourcePath,planPath,securityDDModel,stagingMode'
const DATA_SOURCE_RUNTIME_FIELDS =
  'name,state,deploymentState,activeConnectionsCurrentCount,currCapacity,waitingForConnectionCurrentCount,leakedConnectionCount'
const DATA_SOURCE_CONFIG_FIELDS = 'name,targets'
const DATA_SOURCE_PARAMS_FIELDS =
  'JNDINames,globalTransactionsProtocol,algorithmType,scope,dataSourceList,keepConnAfterGlobalTx'
const LOG_DATA_ACCESS_FIELDS =
  'name,type,columnIndexMap,columnInfoMap,columnTypeMap,columns,earliestAvailableTimestamp,latestAvailableTimestamp,latestRecordId,timestampAvailable,dataArchiveParameters'
const LOG_ARCHIVE_RUNTIME_FIELDS =
  'name,type,recordRetrievalTime,recordSeekCount,recordSeekTime,retrievedRecordCount,dataRetirementCycles,dataRetirementTotalTime,lastDataRetirementStartTime,lastDataRetirementTime,retiredRecordCount,deletionCount,deletionTime,insertionCount,insertionTime,indexPageCount,recordCount,incrementalIndexCycleCount,incrementalIndexTime,indexCycleCount,indexTime,rotatedFilesCount'
const JMS_SERVER_FIELDS =
  'name,state,messagesCurrentCount,messagesPendingCount,destinationsCurrentCount,consumptionPaused,productionPaused,insertionPaused,consumptionPausedState,productionPausedState,insertionPausedState'
const JMS_DESTINATION_FIELDS =
  'name,destinationType,state,messagesCurrentCount,messagesPendingCount,consumersCurrentCount,consumptionPaused,productionPaused,insertionPaused,consumptionPausedState,productionPausedState,insertionPausedState'

const SAFE_READ_ACTIONS = new Set(['wldf-log-record-search'])

async function readEnvFile(path) {
  try {
    const text = await readFile(path, 'utf8')
    return Object.fromEntries(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => {
          const index = line.indexOf('=')
          return [line.slice(0, index), line.slice(index + 1)]
        }),
    )
  } catch {
    return {}
  }
}

function authHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

function sanitizeText(value) {
  return value
    .replace(/https?:\/\/[^/\s"']+/g, 'http://wls-admin.example.com')
    .replace(/\b(?:192\.168|10|172\.(?:1[6-9]|2\d|3[0-1]))\.\d{1,3}\.\d{1,3}\b/g, 'wls-admin.example.com')
    .replace(/\b[a-zA-Z0-9._-]+\.localdomain\b/g, 'wls-host.example.com')
    .replace(/\b[a-zA-Z0-9._-]+\.example\.internal\b/g, 'wls-host.example.com')
    .replace(/\/(?:Users|u01|oracle|domains|private|var|tmp|opt|home)\/[^\s"',}]*/g, '<path>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
}

function sanitizeJson(value) {
  if (typeof value === 'string') return sanitizeText(value)
  if (Array.isArray(value)) return value.slice(0, 200).map(sanitizeJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/authorization|password|credential|secret|token|sourcePath|planPath|url/i.test(key))
        .slice(0, 60)
        .map(([key, child]) => [key, sanitizeJson(child)]),
    )
  }
  return value
}

function valueKind(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function typeMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).slice(0, 60).map(([key, child]) => [key, valueKind(child)]))
}

function bodyShape(value) {
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      firstItemTypeMap: value.length > 0 ? typeMap(value[0]) : {},
    }
  }
  if (value && typeof value === 'object') {
    const items = Array.isArray(value.items) ? value.items : null
    return {
      type: 'object',
      keys: Object.keys(value).slice(0, 60),
      typeMap: typeMap(value),
      itemCount: items?.length,
      firstItemTypeMap: items && items.length > 0 ? typeMap(items[0]) : undefined,
    }
  }
  return { type: valueKind(value) }
}

function pathWithQuery(path, params) {
  const search = new URLSearchParams(params)
  return `${path}?${search.toString()}`
}

function readItems(value) {
  return Array.isArray(value?.items) ? value.items : []
}

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stateCounts(items) {
  const counts = {}
  for (const item of items) {
    const state = readString(item?.state) ?? 'UNKNOWN'
    counts[state] = (counts[state] ?? 0) + 1
  }
  return counts
}

function isRuntimeServer(item) {
  const state = item?.state
  return state === 'RUNNING' || state === 'ADMIN' || state === 'STANDBY'
}

function chooseServers(lifecycleItems, runtimeItems) {
  const candidates = lifecycleItems.length > 0 ? lifecycleItems : runtimeItems
  const admin = candidates.find((item) => item?.name === 'AdminServer' && isRuntimeServer(item))
  const managed = candidates.find((item) => item?.name !== 'AdminServer' && isRuntimeServer(item))
  return [
    admin ? { role: 'admin', name: admin.name } : null,
    managed ? { role: 'running-managed-1', name: managed.name } : null,
  ].filter(Boolean)
}

function chooseFirstNamed(items) {
  return items.find((item) => readString(item?.name)) ?? null
}

function boundedLogWindow(archive) {
  const latest = readNumber(archive?.latestAvailableTimestamp) ?? Date.now()
  const since = new Date(Math.max(0, latest - 15 * 60 * 1000)).toISOString()
  const until = new Date(latest + 1000).toISOString()
  return { since, until, limit: 5 }
}

function assertReadOnly(call) {
  if (call.method === 'GET' || call.method === 'HEAD' || call.method === 'OPTIONS') return
  if (call.method === 'POST' && SAFE_READ_ACTIONS.has(call.readActionKind)) return
  throw new Error(`Refusing non-read call ${call.method} ${call.pathTemplate}`)
}

async function request(context, call) {
  assertReadOnly(call)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const url = new URL(call.path, context.targetUrl)
  const startedAt = performance.now()

  try {
    const response = await fetch(url, {
      method: call.method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: authHeader(context.username, context.password),
        'Content-Type': 'application/json',
        'X-Requested-By': 'wls-cockpit-delta-capture',
      },
      body: call.body ? JSON.stringify(call.body) : undefined,
    })
    const text = await response.text()
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = text ? sanitizeText(text.slice(0, 512)) : null
    }

    return {
      subsystem: call.subsystem,
      name: call.name,
      family: call.family,
      method: call.method,
      readActionKind: call.readActionKind,
      pathTemplate: call.pathTemplate,
      query: call.query ?? null,
      requestBodyShape: call.body ? bodyShape(call.body) : null,
      status: response.status,
      ok: response.ok,
      durationMs: Math.round(performance.now() - startedAt),
      contentType: response.headers.get('content-type'),
      responseShape: parsed === null ? null : bodyShape(parsed),
    }
  } catch (error) {
    return {
      subsystem: call.subsystem,
      name: call.name,
      family: call.family,
      method: call.method,
      readActionKind: call.readActionKind,
      pathTemplate: call.pathTemplate,
      query: call.query ?? null,
      requestBodyShape: call.body ? bodyShape(call.body) : null,
      status: 'error',
      ok: false,
      durationMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.name : String(error),
      message: error instanceof Error ? sanitizeText(error.message) : undefined,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function capture(context) {
  const base = `/management/weblogic/${context.version}`
  const results = []
  const call = async (definition) => {
    const result = await request(context, definition)
    results.push(result)
    return result
  }
  const fetchJson = async (definition) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await fetch(new URL(definition.path, context.targetUrl), {
        method: definition.method,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: authHeader(context.username, context.password),
          'Content-Type': 'application/json',
          'X-Requested-By': 'wls-cockpit-delta-capture',
        },
        body: definition.body ? JSON.stringify(definition.body) : undefined,
      })
      const text = await response.text()
      return text ? JSON.parse(text) : null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  const lifecycleQuery = { fields: SERVER_LIFECYCLE_FIELDS, links: 'none' }
  const lifecyclePath = pathWithQuery(`${base}/domainRuntime/serverLifeCycleRuntimes`, lifecycleQuery)
  const lifecycleDef = {
    subsystem: 'Servers',
    name: 'server lifecycle backbone',
    family: 'serverLifeCycleRuntimes',
    method: 'GET',
    path: lifecyclePath,
    pathTemplate: '/domainRuntime/serverLifeCycleRuntimes',
    query: lifecycleQuery,
  }
  const lifecyclePayload = await fetchJson(lifecycleDef)
  await call(lifecycleDef)

  const aggregateQuery = { fields: SERVER_LIFECYCLE_FIELDS, links: 'none' }
  const aggregatePath = pathWithQuery(`${base}/domainRuntime/serverRuntimes`, aggregateQuery)
  const aggregateDef = {
    subsystem: 'Servers',
    name: 'server runtimes aggregate edge',
    family: 'serverRuntimes',
    method: 'GET',
    path: aggregatePath,
    pathTemplate: '/domainRuntime/serverRuntimes',
    query: aggregateQuery,
  }
  const aggregatePayload = await fetchJson(aggregateDef)
  await call(aggregateDef)

  const lifecycleItems = readItems(lifecyclePayload)
  const aggregateItems = readItems(aggregatePayload)
  const selectedServers = chooseServers(lifecycleItems, aggregateItems)

  for (const server of selectedServers) {
    const serverName = encodeURIComponent(server.name)
    const serverPathTemplate = `/domainRuntime/serverRuntimes/{${server.role}}`
    await call({
      subsystem: 'Servers',
      name: `${server.role} runtime base`,
      family: 'serverRuntimes/{serverName}',
      method: 'GET',
      path: pathWithQuery(`${base}/domainRuntime/serverRuntimes/${serverName}`, {
        fields: SERVER_RUNTIME_BASE_FIELDS,
        links: 'none',
      }),
      pathTemplate: serverPathTemplate,
      query: { fields: SERVER_RUNTIME_BASE_FIELDS, links: 'none' },
    })
    await call({
      subsystem: 'Servers',
      name: `${server.role} JVM runtime`,
      family: 'JVMRuntime',
      method: 'GET',
      path: pathWithQuery(`${base}/domainRuntime/serverRuntimes/${serverName}/JVMRuntime`, {
        fields: JVM_RUNTIME_FIELDS,
        links: 'none',
      }),
      pathTemplate: `${serverPathTemplate}/JVMRuntime`,
      query: { fields: JVM_RUNTIME_FIELDS, links: 'none' },
    })
    await call({
      subsystem: 'Servers',
      name: `${server.role} thread pool runtime`,
      family: 'threadPoolRuntime',
      method: 'GET',
      path: pathWithQuery(`${base}/domainRuntime/serverRuntimes/${serverName}/threadPoolRuntime`, {
        fields: THREAD_POOL_FIELDS,
        links: 'none',
      }),
      pathTemplate: `${serverPathTemplate}/threadPoolRuntime`,
      query: { fields: THREAD_POOL_FIELDS, links: 'none' },
    })
  }

  await call({
    subsystem: 'Deployments',
    name: 'deployment configuration collection',
    family: 'edit/appDeployments',
    method: 'GET',
    path: pathWithQuery(`${base}/edit/appDeployments`, { fields: DEPLOYMENT_CONFIG_FIELDS, links: 'none' }),
    pathTemplate: '/edit/appDeployments',
    query: { fields: DEPLOYMENT_CONFIG_FIELDS, links: 'none' },
  })

  const jdbcConfigPath = pathWithQuery(`${base}/edit/JDBCSystemResources`, {
    fields: DATA_SOURCE_CONFIG_FIELDS,
    links: 'none',
  })
  const jdbcConfigDef = {
    subsystem: 'Data Sources',
    name: 'JDBC system resources collection',
    family: 'edit/JDBCSystemResources',
    method: 'GET',
    path: jdbcConfigPath,
    pathTemplate: '/edit/JDBCSystemResources',
    query: { fields: DATA_SOURCE_CONFIG_FIELDS, links: 'none' },
  }
  const jdbcConfigPayload = await fetchJson(jdbcConfigDef)
  await call(jdbcConfigDef)
  const firstJdbcConfig = chooseFirstNamed(readItems(jdbcConfigPayload))

  if (firstJdbcConfig?.name) {
    const systemResourceName = encodeURIComponent(firstJdbcConfig.name)
    for (const [name, suffix, fields] of [
      ['JDBC datasource params', 'JDBCResource/JDBCDataSourceParams', DATA_SOURCE_PARAMS_FIELDS],
      ['JDBC driver params', 'JDBCResource/JDBCDriverParams', 'driverName,url'],
      ['JDBC pool params', 'JDBCResource/JDBCConnectionPoolParams', 'initialCapacity,minCapacity,maxCapacity,testTableName'],
    ]) {
      await call({
        subsystem: 'Data Sources',
        name,
        family: `edit/JDBCSystemResources/{systemResourceName}/${suffix}`,
        method: 'GET',
        path: pathWithQuery(`${base}/edit/JDBCSystemResources/${systemResourceName}/${suffix}`, {
          fields,
          links: 'none',
        }),
        pathTemplate: `/edit/JDBCSystemResources/{sampleDataSource}/${suffix}`,
        query: { fields, links: 'none' },
      })
    }
  }

  for (const server of selectedServers) {
    const serverName = encodeURIComponent(server.name)
    const serverPathTemplate = `/domainRuntime/serverRuntimes/{${server.role}}`

    await call({
      subsystem: 'Deployments',
      name: `${server.role} application runtimes`,
      family: 'applicationRuntimes',
      method: 'GET',
      path: pathWithQuery(`${base}/domainRuntime/serverRuntimes/${serverName}/applicationRuntimes`, {
        fields: DEPLOYMENT_RUNTIME_FIELDS,
        links: 'none',
      }),
      pathTemplate: `${serverPathTemplate}/applicationRuntimes`,
      query: { fields: DEPLOYMENT_RUNTIME_FIELDS, links: 'none' },
    })

    const jdbcRuntimePath = pathWithQuery(
      `${base}/domainRuntime/serverRuntimes/${serverName}/JDBCServiceRuntime/JDBCDataSourceRuntimeMBeans`,
      { fields: DATA_SOURCE_RUNTIME_FIELDS, links: 'none' },
    )
    const jdbcRuntimeDef = {
      subsystem: 'Data Sources',
      name: `${server.role} JDBC runtime collection`,
      family: 'JDBCDataSourceRuntimeMBeans',
      method: 'GET',
      path: jdbcRuntimePath,
      pathTemplate: `${serverPathTemplate}/JDBCServiceRuntime/JDBCDataSourceRuntimeMBeans`,
      query: { fields: DATA_SOURCE_RUNTIME_FIELDS, links: 'none' },
    }
    const jdbcRuntimePayload = await fetchJson(jdbcRuntimeDef)
    await call(jdbcRuntimeDef)

    const firstJdbcRuntime = chooseFirstNamed(readItems(jdbcRuntimePayload))
    if (firstJdbcRuntime?.name) {
      await call({
        subsystem: 'Data Sources',
        name: `${server.role} sample JDBC runtime detail`,
        family: 'JDBCDataSourceRuntimeMBeans/{dataSourceName}',
        method: 'GET',
        path: pathWithQuery(
          `${base}/domainRuntime/serverRuntimes/${serverName}/JDBCServiceRuntime/JDBCDataSourceRuntimeMBeans/${encodeURIComponent(firstJdbcRuntime.name)}`,
          { fields: DATA_SOURCE_RUNTIME_FIELDS, links: 'none' },
        ),
        pathTemplate: `${serverPathTemplate}/JDBCServiceRuntime/JDBCDataSourceRuntimeMBeans/{sampleDataSource}`,
        query: { fields: DATA_SOURCE_RUNTIME_FIELDS, links: 'none' },
      })
    }

    await call({
      subsystem: 'Logs/WLDF',
      name: `${server.role} log broadcaster`,
      family: 'logBroadcasterRuntime',
      method: 'GET',
      path: pathWithQuery(`${base}/domainRuntime/serverRuntimes/${serverName}/logBroadcasterRuntime`, {
        fields: 'messagesLogged',
        links: 'none',
      }),
      pathTemplate: `${serverPathTemplate}/logBroadcasterRuntime`,
      query: { fields: 'messagesLogged', links: 'none' },
    })
    await call({
      subsystem: 'Logs/WLDF',
      name: `${server.role} server log runtime`,
      family: 'serverLogRuntime',
      method: 'GET',
      path: pathWithQuery(`${base}/domainRuntime/serverRuntimes/${serverName}/serverLogRuntime`, {
        fields: 'logFileStreamOpened',
        links: 'none',
      }),
      pathTemplate: `${serverPathTemplate}/serverLogRuntime`,
      query: { fields: 'logFileStreamOpened', links: 'none' },
    })

    const dataAccessPath = pathWithQuery(
      `${base}/domainRuntime/serverRuntimes/${serverName}/WLDFRuntime/WLDFAccessRuntime/dataAccessRuntimes`,
      { fields: LOG_DATA_ACCESS_FIELDS, links: 'none' },
    )
    const dataAccessDef = {
      subsystem: 'Logs/WLDF',
      name: `${server.role} WLDF data-access collection`,
      family: 'WLDFAccessRuntime/dataAccessRuntimes',
      method: 'GET',
      path: dataAccessPath,
      pathTemplate: `${serverPathTemplate}/WLDFRuntime/WLDFAccessRuntime/dataAccessRuntimes`,
      query: { fields: LOG_DATA_ACCESS_FIELDS, links: 'none' },
    }
    const dataAccessPayload = await fetchJson(dataAccessDef)
    await call(dataAccessDef)

    const archive = readItems(dataAccessPayload).find((item) => item?.name === 'ServerLog') ?? chooseFirstNamed(readItems(dataAccessPayload))
    if (archive?.name) {
      const archiveName = encodeURIComponent(archive.name)
      const archiveBase = `${base}/domainRuntime/serverRuntimes/${serverName}/WLDFRuntime/WLDFAccessRuntime/WLDFDataAccessRuntimes/${archiveName}`
      const archiveTemplate = `${serverPathTemplate}/WLDFRuntime/WLDFAccessRuntime/WLDFDataAccessRuntimes/{sampleArchive}`
      await call({
        subsystem: 'Logs/WLDF',
        name: `${server.role} WLDF data-access detail`,
        family: 'WLDFDataAccessRuntimes/{WLDFDataAccessName}',
        method: 'GET',
        path: pathWithQuery(archiveBase, { fields: LOG_DATA_ACCESS_FIELDS, links: 'none' }),
        pathTemplate: archiveTemplate,
        query: { fields: LOG_DATA_ACCESS_FIELDS, links: 'none' },
      })
      await call({
        subsystem: 'Logs/WLDF',
        name: `${server.role} WLDF archive runtime counters`,
        family: 'WLDFArchiveRuntimes/{WLDFArchiveName}',
        method: 'GET',
        path: pathWithQuery(
          `${base}/domainRuntime/serverRuntimes/${serverName}/WLDFRuntime/WLDFAccessRuntime/archiveRuntimes/${archiveName}`,
          { fields: LOG_ARCHIVE_RUNTIME_FIELDS, links: 'none' },
        ),
        pathTemplate: `${serverPathTemplate}/WLDFRuntime/WLDFAccessRuntime/archiveRuntimes/{sampleArchive}`,
        query: { fields: LOG_ARCHIVE_RUNTIME_FIELDS, links: 'none' },
      })
      await call({
        subsystem: 'Logs/WLDF',
        name: `${server.role} WLDF ServerLog search`,
        family: 'WLDFDataAccessRuntimes/{WLDFDataAccessName}/search',
        method: 'POST',
        readActionKind: 'wldf-log-record-search',
        path: pathWithQuery(`${archiveBase}/search`, {
          internal: 'true',
          expandedValues: 'false',
          saveChanges: 'false',
          enableConsoleRestExtension: 'true',
        }),
        pathTemplate: `${archiveTemplate}/search`,
        query: {
          internal: true,
          expandedValues: false,
          saveChanges: false,
          enableConsoleRestExtension: true,
        },
        body: boundedLogWindow(archive),
      })
    }

    const jmsPath = pathWithQuery(`${base}/domainRuntime/serverRuntimes/${serverName}/JMSRuntime/JMSServers`, {
      fields: JMS_SERVER_FIELDS,
      links: 'none',
    })
    const jmsDef = {
      subsystem: 'JMS',
      name: `${server.role} JMS server collection`,
      family: 'JMSRuntime/JMSServers',
      method: 'GET',
      path: jmsPath,
      pathTemplate: `${serverPathTemplate}/JMSRuntime/JMSServers`,
      query: { fields: JMS_SERVER_FIELDS, links: 'none' },
    }
    const jmsPayload = await fetchJson(jmsDef)
    await call(jmsDef)

    const jmsServer = readItems(jmsPayload).find((item) => readNumber(item?.destinationsCurrentCount) > 0) ?? chooseFirstNamed(readItems(jmsPayload))
    if (jmsServer?.name) {
      await call({
        subsystem: 'JMS',
        name: `${server.role} sample JMS destinations`,
        family: 'JMSRuntime/JMSServers/{JMSServerName}/destinations',
        method: 'GET',
        path: pathWithQuery(
          `${base}/domainRuntime/serverRuntimes/${serverName}/JMSRuntime/JMSServers/${encodeURIComponent(jmsServer.name)}/destinations`,
          { fields: JMS_DESTINATION_FIELDS, links: 'none' },
        ),
        pathTemplate: `${serverPathTemplate}/JMSRuntime/JMSServers/{sampleJmsServer}/destinations`,
        query: { fields: JMS_DESTINATION_FIELDS, links: 'none' },
      })
    }
  }

  const findings = summarizeFindings(results)
  return {
    generatedAt: new Date().toISOString(),
    restVersion: context.version,
    target: 'sanitized lab AdminServer origin',
    readOnlyBoundary: {
      allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
      declaredReadActions: Array.from(SAFE_READ_ACTIONS),
      mutationFamiliesExcluded: [
        'lifecycle',
        'deploy',
        'undeploy',
        'redeploy',
        'datasource mutation',
        'edit-tree mutation',
        'filesystem',
        'SSH',
        'WLST',
        'Node Manager',
        'custom extension',
      ],
    },
    topology: {
      lifecycleItemCount: lifecycleItems.length,
      lifecycleStateCounts: stateCounts(lifecycleItems),
      aggregateItemCount: aggregateItems.length,
      aggregateStateCounts: stateCounts(aggregateItems),
      selectedServerRoles: selectedServers.map((server) => server.role),
    },
    captureList: captureListSummary(results),
    findings,
    results,
  }
}

function captureListSummary(results) {
  const grouped = new Map()
  for (const result of results) {
    if (!grouped.has(result.subsystem)) grouped.set(result.subsystem, new Set())
    grouped.get(result.subsystem).add(result.family)
  }
  return Array.from(grouped.entries()).map(([subsystem, families]) => ({
    subsystem,
    families: Array.from(families).sort(),
  }))
}

function summarizeFindings(results) {
  const bySubsystem = new Map()
  for (const result of results) {
    if (!bySubsystem.has(result.subsystem)) {
      bySubsystem.set(result.subsystem, { total: 0, ok: 0, failed: 0, statuses: {}, notes: [] })
    }
    const item = bySubsystem.get(result.subsystem)
    item.total += 1
    if (result.ok) item.ok += 1
    else item.failed += 1
    const status = String(result.status)
    item.statuses[status] = (item.statuses[status] ?? 0) + 1
  }

  for (const result of results) {
    if (result.family === 'serverRuntimes' && !result.ok) {
      bySubsystem.get(result.subsystem).notes.push({
        endpointFamily: result.family,
        observed: `aggregate server runtime collection returned ${result.status}`,
        cockpitTolerance: 'Cockpit uses serverLifeCycleRuntimes plus bounded per-server runtime fan-out.',
        openApiFollowUp: 'Keep 12c aggregate fan-out quirk guidance.',
      })
    }
    if (result.family === 'WLDFDataAccessRuntimes/{WLDFDataAccessName}/search' && result.ok) {
      bySubsystem.get(result.subsystem).notes.push({
        endpointFamily: result.family,
        observed: 'bounded WLDF ServerLog search returned successfully as a declared read action',
        cockpitTolerance: 'Cockpit normalizes record fields defensively, including numeric-string timestamps.',
        openApiFollowUp: 'Mark empirical support for this WebLogic REST version where appropriate.',
      })
    }
    if (result.family === 'JMSRuntime/JMSServers/{JMSServerName}/destinations' && result.ok) {
      bySubsystem.get(result.subsystem).notes.push({
        endpointFamily: result.family,
        observed: 'destination fan-out is available for at least one JMS server',
        cockpitTolerance: 'Cockpit fans out only when server-level counters justify destination reads.',
        openApiFollowUp: 'No schema change unless field type drift is observed across versions.',
      })
    }
  }

  return Array.from(bySubsystem.entries()).map(([subsystem, summary]) => ({
    subsystem,
    total: summary.total,
    ok: summary.ok,
    failed: summary.failed,
    statuses: summary.statuses,
    notes: summary.notes,
  }))
}

async function loadContext() {
  const localEnv = await readEnvFile(APP_ENV)
  const targetInput = process.env.WLS_DELTA_TARGET ?? localEnv.VITE_WLS_TARGET
  const username = process.env.WLS_DELTA_USERNAME ?? process.env.WLS_SPIKE_USERNAME
  const password = process.env.WLS_DELTA_PASSWORD ?? process.env.WLS_SPIKE_PASSWORD
  const version = process.env.WLS_DELTA_VERSION ?? localEnv.VITE_WLS_DEFAULT_VERSION ?? '14.1.2.0.0'
  const { normalizeWlsTarget } = await import(pathToFileURL(PROXY_TARGET_MODULE).href)
  const target = normalizeWlsTarget(targetInput)

  if (!target.ok) throw new Error(target.error)
  if (!username || !password) {
    throw new Error('Set WLS_DELTA_USERNAME/WLS_DELTA_PASSWORD or WLS_SPIKE_USERNAME/WLS_SPIKE_PASSWORD.')
  }

  return {
    targetUrl: target.targetUrl,
    username,
    password,
    version,
  }
}

function selfTest() {
  assert.equal(sanitizeText('http://wls-admin.internal:7001/foo'), 'http://wls-admin.example.com/foo')
  assert.equal(sanitizeText(`http://${['10', '0', '0', '39'].join('.')}:7001/foo`), 'http://wls-admin.example.com/foo')
  assert.equal(sanitizeText('/opt/example/domain/security/file.txt'), '<path>')
  assert.equal(sanitizeJson({ password: 'secret', value: 'ok' }).password, undefined)
  assert.throws(() =>
    assertReadOnly({
      method: 'POST',
      pathTemplate: '/management/weblogic/latest/domainRuntime/serverLifeCycleRuntimes/server1/start',
    }),
  )
  assert.doesNotThrow(() =>
    assertReadOnly({
      method: 'POST',
      readActionKind: 'wldf-log-record-search',
      pathTemplate: '/domainRuntime/serverRuntimes/{server}/WLDFDataAccessRuntimes/{archive}/search',
    }),
  )
}

async function main() {
  if (process.argv.includes('--self-test')) {
    selfTest()
    console.log('self-test ok')
    return
  }

  const context = await loadContext()
  const output = sanitizeJson(await capture(context))
  await mkdir(dirname(OUTPUT), { recursive: true })
  await writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`)
  console.log(`Wrote ${OUTPUT}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
