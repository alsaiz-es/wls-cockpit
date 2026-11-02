import type { WlsVersion } from '../wls-version.ts'

export type TopologyResourceKind = 'server' | 'cluster'
export type TopologyEndpointKind = 'root' | 'singleton-child' | 'collection-child'
export type TopologyMutationCapability = 'create' | 'update' | 'delete'
export type TopologyFieldValueKind =
  | 'boolean'
  | 'enum'
  | 'integer'
  | 'object'
  | 'reference'
  | 'reference-list'
  | 'secret'
  | 'string'
  | 'string-list'
export type TopologyFieldWriteSupport = 'editable' | 'create-only' | 'read-only' | 'unsupported' | 'write-only'
export type TopologySensitivity = 'none' | 'credential' | 'encrypted' | 'filesystem-path' | 'startup-argument'

export interface TopologyFieldValidation {
  min?: number
  max?: number
  pattern?: string
  enumValues?: string[]
}

export interface TopologyFieldMetadata {
  id: string
  resourceKind: TopologyResourceKind
  endpointId: string
  sectionId: string
  sectionLabel: string
  jsonProperty: string
  label: string
  valueKind: TopologyFieldValueKind
  validation: TopologyFieldValidation | null
  writeSupport: TopologyFieldWriteSupport
  readOnlyReason: string | null
  unavailableReason: string | null
  sensitive: boolean
  sensitivity: TopologySensitivity
  restartNote: string | null
  supportedVersions: WlsVersion[]
}

export interface TopologyEndpointCatalog {
  id: string
  resourceKind: TopologyResourceKind
  sectionId: string
  sectionLabel: string
  endpointKind: TopologyEndpointKind
  pathTemplate: string
  collectionPathTemplate: string | null
  childNameParam: string | null
  capabilities: TopologyMutationCapability[]
  fields: TopologyFieldMetadata[]
  supportedVersions: WlsVersion[]
}

export interface TopologySectionCatalog {
  id: string
  resourceKind: TopologyResourceKind
  label: string
  endpointIds: string[]
  fields: TopologyFieldMetadata[]
}

const WLS12: WlsVersion = '12.2.1.4.0'
const WLS14: WlsVersion = '14.1.2.0.0'
export const TOPOLOGY_SUPPORTED_WLS_VERSIONS = [WLS14, WLS12] as const

type FieldInput = string | [string, Partial<Omit<TopologyFieldMetadata, 'id' | 'resourceKind' | 'endpointId' | 'sectionId' | 'sectionLabel' | 'jsonProperty'>>]

interface EndpointInput {
  id: string
  resourceKind: TopologyResourceKind
  sectionId: string
  sectionLabel: string
  endpointKind: TopologyEndpointKind
  pathTemplate: string
  collectionPathTemplate?: string
  childNameParam?: string
  capabilities?: TopologyMutationCapability[]
  supportedVersions?: WlsVersion[]
  fields: FieldInput[]
}

function labelFromProperty(property: string) {
  return property
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\bJTA\b/g, 'JTA')
    .replace(/\bJDBC\b/g, 'JDBC')
    .replace(/\bIIOP\b/g, 'IIOP')
    .replace(/\bSSL\b/g, 'SSL')
    .replace(/\bWLDF\b/g, 'WLDF')
    .replace(/\bHTTP\b/g, 'HTTP')
    .replace(/\bHTTPS\b/g, 'HTTPS')
    .replace(/\bRMI\b/g, 'RMI')
    .replace(/\bXML\b/g, 'XML')
    .replace(/\bJMS\b/g, 'JMS')
    .replace(/\bNM\b/g, 'NM')
}

const referenceProperties = new Set([
  'allCandidateServers',
  'candidateMachines',
  'candidateMachinesForMigratableServers',
  'cluster',
  'coherenceClusterSystemResource',
  'dataSourceForAutomaticMigration',
  'dataSourceForJobScheduler',
  'dataSourceForSessionPersistence',
  'diagnosticJDBCResource',
  'hostingServer',
  'machine',
  'reliableDeliveryPolicy',
  'serverTemplate',
  'servers',
  'targets',
  'userPreferredServer',
  'XMLEntityCache',
  'XMLRegistry',
])

const enumProperties = new Set([
  'administrationProtocol',
  'allowListViolationAction',
  'autoMigrationTableCreationPolicy',
  'clusterMessagingMode',
  'clusterType',
  'defaultProtocol',
  'defaultSecureProtocol',
  'diagnosticDataArchiveType',
  'failureAction',
  'identityAndTrustLocations',
  'inboundCertificateValidation',
  'JMSConnectionFactoryUnmappedResRefMode',
  'keyStores',
  'logFileSeverity',
  'loggerSeverity',
  'migrationBasis',
  'outboundCertificateValidation',
  'panicAction',
  'parallelXADispatchPolicy',
  'protocol',
  'rotationType',
  'securityInteropMode',
  'stagingMode',
  'startupMode',
  'stdoutFormat',
  'stdoutSeverity',
  'synchronousWritePolicy',
  'systemSecurity',
  'transactionLogFileWritePolicy',
  'txMechanism',
  'virtualThreadEnableOption',
  'WSATTransportSecurityMode',
])

const stringListProperties = new Set([
  'activeServersInRemoteCluster',
  'ciphersuites',
  'determinerCandidateResourceInfoList',
  'determiners',
  'domainLogBroadcastFilter',
  'dynamicServerNames',
  'excludedCiphersuites',
  'JNDITransportableObjectFactoryList',
  'logFileFilter',
  'tags',
  'stdoutFilter',
  'useNonSecureAddressesForDomains',
  'usePublicAddressesForRemoteDomains',
])

const readOnlyProperties = new Set(['dynamicallyCreated', 'dynamicServerNames', 'id', 'type'])

const portProperties = new Set([
  'administrationPort',
  'buzzPort',
  'frontendHTTPPort',
  'frontendHTTPSPort',
  'listenPort',
  'multicastPort',
  'proxyPort',
  'publicPort',
])

const booleanPrefixes = [
  'accept',
  'allow',
  'auto',
  'calculated',
  'channelIdentityCustomized',
  'chunked',
  'cleanup',
  'client',
  'clusterwide',
  'concurrent',
  'dataRetirement',
  'defaultDatasource',
  'enabled',
  'gathered',
  'greedy',
  'heapDumping',
  'hostnameVerificationIgnored',
  'hosts',
  'http',
  'ignore',
  'instrument',
  'JSSE',
  'keep',
  'listeners',
  'log',
  'managed',
  'member',
  'message',
  'native',
  'numberOfFilesLimited',
  'oneWay',
  'outbound',
  'persist',
  'prefetch',
  'print',
  'redirect',
  'resolve',
  'restart',
  'scattered',
  'secure',
  'send',
  'server',
  'session',
  'singleSignon',
  'sit',
  'socketBuffer',
  'SSL',
  'synchronized',
  'TLOG',
  'tightly',
  'timeout',
  'tunneling',
  'two',
  'txn',
  'use',
  'verbose',
  'weblogic',
  'WSAT',
]

function inferValueKind(property: string): TopologyFieldValueKind {
  if (referenceProperties.has(property)) return property === 'cluster' || property === 'machine' || property === 'serverTemplate' ? 'reference' : 'reference-list'
  if (enumProperties.has(property)) return 'enum'
  if (stringListProperties.has(property)) return 'string-list'
  if (/encrypted/i.test(property) || /password|passphrase/i.test(property)) return 'secret'
  if (portProperties.has(property)) return 'integer'
  if (/count|delay|depth|idlePeriods|interval|lifespan|limit|max|min|millis|period|percent|port|secs|seconds|size|span|threshold|time|timeout|ttl|weight/i.test(property)) {
    return 'integer'
  }
  if (booleanPrefixes.some((prefix) => property.startsWith(prefix))) return 'boolean'
  return 'string'
}

function inferValidation(property: string, valueKind: TopologyFieldValueKind): TopologyFieldValidation | null {
  if (portProperties.has(property)) return { min: 1, max: 65_535 }
  if (valueKind === 'integer') return { min: 0, max: 2_147_483_647 }
  if (property === 'name') return { pattern: '^[^/\\\\\\x00-\\x1f]+$' }
  return null
}

function inferSensitivity(property: string): TopologySensitivity {
  if (/encrypted/i.test(property)) return 'encrypted'
  if (/password|passphrase|credential|privatekey/i.test(property)) return 'credential'
  if (/arguments/i.test(property)) return 'startup-argument'
  if (/classpath|directory|dirname|filename|javahome|mwhome|path|rootdirectory|securitypolicyfile/i.test(property)) {
    return 'filesystem-path'
  }
  return 'none'
}

function inferWriteSupport(property: string, sensitivity: TopologySensitivity): TopologyFieldWriteSupport {
  if (property === 'name') return 'create-only'
  if (readOnlyProperties.has(property)) return 'read-only'
  if (sensitivity === 'encrypted') return 'read-only'
  if (sensitivity === 'credential' || sensitivity === 'startup-argument') return 'write-only'
  return 'editable'
}

function inferRestartNote(property: string) {
  if (/listen|port|protocol|cluster|machine|startup|staging|keystore|ssl|transaction|migration|thread|socket|replication|multicast|fencing|leasing/i.test(property)) {
    return 'May require server restart or redeploy according to WebLogic edit-tree metadata.'
  }
  return null
}

function normalizeFieldInput(
  input: FieldInput,
  endpoint: Omit<TopologyEndpointCatalog, 'fields'>,
): TopologyFieldMetadata {
  const property = typeof input === 'string' ? input : input[0]
  const overrides = typeof input === 'string' ? {} : input[1]
  const valueKind = overrides.valueKind ?? inferValueKind(property)
  const sensitivity = overrides.sensitivity ?? inferSensitivity(property)
  const writeSupport = overrides.writeSupport ?? inferWriteSupport(property, sensitivity)
  const readOnlyReason = overrides.readOnlyReason ?? (writeSupport === 'read-only' ? 'Reported by WebLogic as configuration metadata and not edited by Cockpit.' : null)
  const unavailableReason = overrides.unavailableReason ?? null
  return {
    id: `${endpoint.id}.${property}`,
    resourceKind: endpoint.resourceKind,
    endpointId: endpoint.id,
    sectionId: endpoint.sectionId,
    sectionLabel: endpoint.sectionLabel,
    jsonProperty: property,
    label: overrides.label ?? labelFromProperty(property),
    valueKind,
    validation: overrides.validation ?? inferValidation(property, valueKind),
    writeSupport,
    readOnlyReason,
    unavailableReason,
    sensitive: overrides.sensitive ?? sensitivity !== 'none',
    sensitivity,
    restartNote: overrides.restartNote ?? inferRestartNote(property),
    supportedVersions: overrides.supportedVersions ?? endpoint.supportedVersions,
  }
}

function endpoint(input: EndpointInput): TopologyEndpointCatalog {
  const base = {
    id: input.id,
    resourceKind: input.resourceKind,
    sectionId: input.sectionId,
    sectionLabel: input.sectionLabel,
    endpointKind: input.endpointKind,
    pathTemplate: input.pathTemplate,
    collectionPathTemplate: input.collectionPathTemplate ?? null,
    childNameParam: input.childNameParam ?? null,
    capabilities: input.capabilities ?? ['update'],
    supportedVersions: input.supportedVersions ?? [WLS14, WLS12],
  } satisfies Omit<TopologyEndpointCatalog, 'fields'>

  return {
    ...base,
    fields: input.fields.map((field) => normalizeFieldInput(field, base)),
  }
}

export const TOPOLOGY_ENDPOINTS: TopologyEndpointCatalog[] = [
  endpoint({
    id: 'server.root',
    resourceKind: 'server',
    sectionId: 'identity',
    sectionLabel: 'Identity and Listen',
    endpointKind: 'root',
    pathTemplate: '/edit/servers/{serverName}',
    collectionPathTemplate: '/edit/servers',
    capabilities: ['create', 'update', 'delete'],
    fields: [
      'name',
      'type',
      'dynamicallyCreated',
      'id',
      'notes',
      'tags',
      'listenAddress',
      'listenPort',
      'listenPortEnabled',
      'externalDNSName',
      'interfaceAddress',
      'administrationPort',
      'administrationProtocol',
      'defaultProtocol',
      'defaultSecureProtocol',
      'loginTimeoutMillis',
      'acceptBacklog',
      'maxOpenSockCount',
      'maxMessageSize',
      'completeMessageTimeout',
      'completeWriteTimeout',
      'connectTimeout',
      'idleConnectionTimeout',
      'tunnelingEnabled',
      'tunnelingClientPingSecs',
      'tunnelingClientTimeoutSecs',
      'resolveDNSName',
      'reverseDNSAllowed',
      'weblogicPluginEnabled',
    ],
  }),
  endpoint({
    id: 'server.references',
    resourceKind: 'server',
    sectionId: 'references',
    sectionLabel: 'Cluster and Machine',
    endpointKind: 'root',
    pathTemplate: '/edit/servers/{serverName}',
    collectionPathTemplate: '/edit/servers',
    capabilities: ['create', 'update'],
    fields: [
      'cluster',
      'clusterWeight',
      'machine',
      'candidateMachines',
      'coherenceClusterSystemResource',
      'reliableDeliveryPolicy',
      'serverTemplate',
      'replicationGroup',
      'preferredSecondaryGroup',
      'replicationPorts',
    ],
  }),
  endpoint({
    id: 'server.lifecycle',
    resourceKind: 'server',
    sectionId: 'lifecycle',
    sectionLabel: 'Startup and Lifecycle',
    endpointKind: 'root',
    pathTemplate: '/edit/servers/{serverName}',
    collectionPathTemplate: '/edit/servers',
    capabilities: ['create', 'update'],
    fields: [
      'autoRestart',
      'restartMax',
      'restartDelaySeconds',
      'restartIntervalSeconds',
      'startupMode',
      'startupTimeout',
      'serverLifeCycleTimeoutVal',
      'gracefulShutdownTimeout',
      'ignoreSessionsDuringShutdown',
      'sessionReplicationOnShutdownEnabled',
      'managedServerIndependenceEnabled',
      'numOfRetriesBeforeMSIMode',
      'retryIntervalBeforeMSIMode',
      'listenThreadStartDelaySecs',
    ],
  }),
  endpoint({
    id: 'server.security',
    resourceKind: 'server',
    sectionId: 'security',
    sectionLabel: 'Security and Keystores',
    endpointKind: 'root',
    pathTemplate: '/edit/servers/{serverName}',
    collectionPathTemplate: '/edit/servers',
    capabilities: ['create', 'update'],
    fields: [
      'keyStores',
      'customIdentityKeyStoreFileName',
      'customIdentityKeyStoreType',
      'customIdentityKeyStorePassPhrase',
      'customIdentityKeyStorePassPhraseEncrypted',
      'customTrustKeyStoreFileName',
      'customTrustKeyStoreType',
      'customTrustKeyStorePassPhrase',
      'customTrustKeyStorePassPhraseEncrypted',
      'javaStandardTrustKeyStorePassPhrase',
      'javaStandardTrustKeyStorePassPhraseEncrypted',
      'defaultIIOPUser',
      'defaultIIOPPassword',
      'defaultIIOPPasswordEncrypted',
      'defaultTGIOPUser',
      'defaultTGIOPPassword',
      'defaultTGIOPPasswordEncrypted',
      'systemPasswordEncrypted',
      'clientCertProxyEnabled',
    ],
  }),
  endpoint({
    id: 'server.threading',
    resourceKind: 'server',
    sectionId: 'threading',
    sectionLabel: 'Threads and Request Queues',
    endpointKind: 'root',
    pathTemplate: '/edit/servers/{serverName}',
    collectionPathTemplate: '/edit/servers',
    capabilities: ['create', 'update'],
    fields: [
      'addWorkManagerThreadsByCpuCount',
      'allowShrinkingPriorityRequestQueue',
      'DGCIdlePeriodsUntilTimeout',
      'eagerThreadLocalCleanup',
      'gatheredWritesEnabled',
      'nativeIOEnabled',
      'periodLength',
      'scatteredReadsEnabled',
      'selfTuningThreadPoolSizeMax',
      'selfTuningThreadPoolSizeMin',
      'socketBufferSizeAsChunkSize',
      'socketReaders',
      'stuckThreadTimerInterval',
      'threadPoolPercentSocketReaders',
      'use81StyleExecuteQueues',
      'useConcurrentQueueForRequestManager',
      'useDetailedThreadName',
      'useEnhancedIncrementAdvisor',
      'useEnhancedPriorityQueueForRequestManager',
      ['virtualThreadEnableOption', { supportedVersions: [WLS14] }],
      ['isolatePartitionThreadLocals', { supportedVersions: [WLS12] }],
    ],
  }),
  endpoint({
    id: 'server.staging',
    resourceKind: 'server',
    sectionId: 'staging',
    sectionLabel: 'Staging and Compilers',
    endpointKind: 'root',
    pathTemplate: '/edit/servers/{serverName}',
    collectionPathTemplate: '/edit/servers',
    capabilities: ['create', 'update'],
    fields: [
      'classpathServletDisabled',
      'classpathServletSecureModeEnabled',
      'defaultInternalServletsDisabled',
      'extraEjbcOptions',
      'extraRmicOptions',
      'javaCompiler',
      'javaCompilerPostClassPath',
      'javaCompilerPreClassPath',
      'stagingDirectoryName',
      'stagingMode',
      'uploadDirectoryName',
    ],
  }),
  endpoint({
    id: 'server.t3iiop',
    resourceKind: 'server',
    sectionId: 'protocols',
    sectionLabel: 'Protocols',
    endpointKind: 'root',
    pathTemplate: '/edit/servers/{serverName}',
    collectionPathTemplate: '/edit/servers',
    capabilities: ['create', 'update'],
    fields: [
      'COMEnabled',
      'IIOPEnabled',
      'TGIOPEnabled',
      'outboundEnabled',
      'outboundPrivateKeyEnabled',
      'JNDITransportableObjectFactoryList',
      'JMSConnectionFactoryUnmappedResRefMode',
      ['buzzAddress', { supportedVersions: [WLS12] }],
      ['buzzEnabled', { supportedVersions: [WLS12] }],
      ['buzzPort', { supportedVersions: [WLS12] }],
    ],
  }),
  endpoint({
    id: 'server.transactions',
    resourceKind: 'server',
    sectionId: 'transactions',
    sectionLabel: 'JTA and Migration',
    endpointKind: 'root',
    pathTemplate: '/edit/servers/{serverName}',
    collectionPathTemplate: '/edit/servers',
    capabilities: ['create', 'update'],
    fields: [
      'JDBCLLRTableName',
      'JDBCLoginTimeoutSeconds',
      'transactionLogFilePrefix',
      'transactionLogFileWritePolicy',
      'transactionPrimaryChannelName',
      'transactionPublicChannelName',
      'transactionPublicSecureChannelName',
      'transactionSecureChannelName',
      'hostsMigratableServices',
      'autoMigrationEnabled',
    ],
  }),
  endpoint({
    id: 'server.ssl',
    resourceKind: 'server',
    sectionId: 'ssl',
    sectionLabel: 'SSL',
    endpointKind: 'singleton-child',
    pathTemplate: '/edit/servers/{serverName}/SSL',
    fields: [
      'name',
      'enabled',
      'listenPort',
      'clientCertificateEnforced',
      'twoWaySSLEnabled',
      'hostnameVerificationIgnored',
      'hostnameVerifier',
      'minimumTLSProtocolVersion',
      'JSSEEnabled',
      'identityAndTrustLocations',
      'inboundCertificateValidation',
      'outboundCertificateValidation',
      'ciphersuites',
      ['excludedCiphersuites', { supportedVersions: [WLS14] }],
      'serverPrivateKeyAlias',
      'serverPrivateKeyPassPhrase',
      'serverPrivateKeyPassPhraseEncrypted',
      'clientCertAlias',
      'clientCertPrivateKeyPassPhrase',
      'clientCertPrivateKeyPassPhraseEncrypted',
      'outboundPrivateKeyAlias',
      'outboundPrivateKeyPassPhrase',
      'outboundPrivateKeyPassPhraseEncrypted',
      ['serverCipherSuitesOrderEnabled', { supportedVersions: [WLS14] }],
      'SSLRejectionLoggingEnabled',
      'SSLv2HelloEnabled',
      'useClientCertForOutbound',
      'useServerCerts',
    ],
  }),
  endpoint({
    id: 'server.startup',
    resourceKind: 'server',
    sectionId: 'startup',
    sectionLabel: 'Server Start',
    endpointKind: 'singleton-child',
    pathTemplate: '/edit/servers/{serverName}/serverStart',
    fields: [
      'name',
      'arguments',
      'classPath',
      'javaHome',
      'javaVendor',
      'MWHome',
      'rootDirectory',
      'securityPolicyFile',
      'username',
      'password',
      'passwordEncrypted',
    ],
  }),
  endpoint({
    id: 'server.log',
    resourceKind: 'server',
    sectionId: 'logging',
    sectionLabel: 'Logging',
    endpointKind: 'singleton-child',
    pathTemplate: '/edit/servers/{serverName}/log',
    fields: [
      'name',
      'fileName',
      'logFileRotationDir',
      'rotationType',
      'rotationTime',
      'fileCount',
      'fileMinSize',
      'fileTimeSpan',
      'numberOfFilesLimited',
      'rotateLogOnStartup',
      'bufferSizeKB',
      'dateFormatPattern',
      'logFileSeverity',
      'loggerSeverity',
      'stdoutSeverity',
      'stdoutFormat',
      'stdoutLogStack',
      'redirectStderrToServerLogEnabled',
      'redirectStdoutToServerLogEnabled',
      'domainLogBroadcastSeverity',
      'logMonitoringEnabled',
      'logMonitoringIntervalSecs',
      'logMonitoringThrottleThreshold',
    ],
  }),
  endpoint({
    id: 'server.networkAccessPoints',
    resourceKind: 'server',
    sectionId: 'network-channels',
    sectionLabel: 'Network Channels',
    endpointKind: 'collection-child',
    pathTemplate: '/edit/servers/{serverName}/networkAccessPoints/{channelName}',
    collectionPathTemplate: '/edit/servers/{serverName}/networkAccessPoints',
    childNameParam: 'channelName',
    capabilities: ['create', 'update', 'delete'],
    fields: [
      'name',
      'enabled',
      'protocol',
      'listenAddress',
      'listenPort',
      'publicAddress',
      'publicPort',
      'proxyAddress',
      'proxyPort',
      'clusterAddress',
      'httpEnabledForThisProtocol',
      'outboundEnabled',
      'outboundPrivateKeyEnabled',
      'tunnelingEnabled',
      'tunnelingClientPingSecs',
      'tunnelingClientTimeoutSecs',
      'maxMessageSize',
      'completeMessageTimeout',
      'idleConnectionTimeout',
      'connectTimeout',
      'loginTimeoutMillis',
      'acceptBacklog',
      'maxConnectedClients',
      'channelWeight',
      'resolveDNSName',
      'allowUnencryptedNullCipher',
      'clientCertificateEnforced',
      'twoWaySSLEnabled',
      'hostnameVerificationIgnored',
      'hostnameVerifier',
      'minimumTLSProtocolVersion',
      'ciphersuites',
      ['excludedCiphersuites', { supportedVersions: [WLS14] }],
      'customIdentityKeyStoreFileName',
      'customIdentityKeyStoreType',
      'customIdentityKeyStorePassPhrase',
      'customIdentityKeyStorePassPhraseEncrypted',
      'customPrivateKeyAlias',
      'customPrivateKeyPassPhrase',
      'customPrivateKeyPassPhraseEncrypted',
      'privateKeyAlias',
      'privateKeyPassPhrase',
      'outboundPrivateKeyAlias',
      'outboundPrivateKeyPassPhrase',
      ['serverCipherSuitesOrderEnabled', { supportedVersions: [WLS14] }],
      'SSLv2HelloEnabled',
      'timeoutConnectionWithPendingResponses',
      'useFastSerialization',
    ],
  }),
  endpoint({
    id: 'server.overloadProtection',
    resourceKind: 'server',
    sectionId: 'overload',
    sectionLabel: 'Overload Protection',
    endpointKind: 'singleton-child',
    pathTemplate: '/edit/servers/{serverName}/overloadProtection',
    fields: [
      'name',
      'failureAction',
      'panicAction',
      'freeMemoryPercentHighThreshold',
      'freeMemoryPercentLowThreshold',
      'sharedCapacityForWorkManagers',
    ],
  }),
  endpoint({
    id: 'server.serverFailureTrigger',
    resourceKind: 'server',
    sectionId: 'overload',
    sectionLabel: 'Server Failure Trigger',
    endpointKind: 'singleton-child',
    pathTemplate: '/edit/servers/{serverName}/overloadProtection/serverFailureTrigger',
    fields: [
      'name',
      'maxStuckThreadTime',
      'stuckThreadCount',
      ['heapDumpingOnDeadlock', { supportedVersions: [WLS14] }],
      ['heapDumpingOnMaxStuckThread', { supportedVersions: [WLS14] }],
    ],
  }),
  endpoint({
    id: 'server.diagnostics',
    resourceKind: 'server',
    sectionId: 'diagnostics',
    sectionLabel: 'Diagnostics',
    endpointKind: 'singleton-child',
    pathTemplate: '/edit/servers/{serverName}/serverDiagnosticConfig',
    fields: [
      'name',
      'diagnosticDataArchiveType',
      'diagnosticDumpsDir',
      'diagnosticJDBCResource',
      'diagnosticJDBCSchemaName',
      'diagnosticStoreDir',
      'diagnosticStoreFileLockingEnabled',
      'diagnosticStoreMaxFileSize',
      'diagnosticStoreMinWindowBufferSize',
      'diagnosticStoreMaxWindowBufferSize',
      'diagnosticStoreIoBufferSize',
      'eventPersistenceInterval',
      'eventsImageCaptureInterval',
      'imageDir',
      'imageTimeout',
      'maxHeapDumpCount',
      'maxThreadDumpCount',
      'preferredStoreSizeLimit',
      'storeSizeCheckPeriod',
      'synchronousEventPersistenceEnabled',
      'dataRetirementEnabled',
      'WLDFDiagnosticVolume',
      ['WLDFBuiltinWatchConfiguration', { supportedVersions: [WLS14], valueKind: 'object', writeSupport: 'read-only' }],
    ],
  }),
  endpoint({
    id: 'server.webServer',
    resourceKind: 'server',
    sectionId: 'web-server',
    sectionLabel: 'Web Server',
    endpointKind: 'singleton-child',
    pathTemplate: '/edit/servers/{serverName}/webServer',
    fields: [
      'name',
      'defaultWebAppContextRoot',
      'frontendHost',
      'frontendHTTPPort',
      'frontendHTTPSPort',
      'keepAliveEnabled',
      'keepAliveSecs',
      'httpsKeepAliveSecs',
      'maxPostSize',
      'maxPostTimeSecs',
      'maxRequestParameterCount',
      'maxSingleHeaderSize',
      'maxTotalHeadersSize',
      'overloadResponseCode',
      'postTimeoutSecs',
      'sendServerHeaderEnabled',
      'singleSignonDisabled',
      'authCookieEnabled',
      'chunkedTransferDisabled',
      'clientIpHeader',
      'acceptContextPathInGetRealPath',
      'useHeaderEncoding',
      'useHighestCompatibleHTTPVersion',
      'WAPEnabled',
      'writeChunkBytes',
    ],
  }),
  endpoint({
    id: 'cluster.root',
    resourceKind: 'cluster',
    sectionId: 'identity',
    sectionLabel: 'Identity and Messaging',
    endpointKind: 'root',
    pathTemplate: '/edit/clusters/{clusterName}',
    collectionPathTemplate: '/edit/clusters',
    capabilities: ['create', 'update', 'delete'],
    fields: [
      'name',
      'type',
      'dynamicallyCreated',
      'id',
      'notes',
      'tags',
      'clusterAddress',
      'clusterBroadcastChannel',
      'clusterMessagingMode',
      'clusterType',
      'defaultLoadAlgorithm',
      'frontendHost',
      'frontendHTTPPort',
      'frontendHTTPSPort',
      'numberOfServersInClusterAddress',
      'servers',
      'siteName',
      'weblogicPluginEnabled',
    ],
  }),
  endpoint({
    id: 'cluster.migration',
    resourceKind: 'cluster',
    sectionId: 'leasing-migration',
    sectionLabel: 'Leasing and Migration',
    endpointKind: 'root',
    pathTemplate: '/edit/clusters/{clusterName}',
    collectionPathTemplate: '/edit/clusters',
    capabilities: ['create', 'update'],
    fields: [
      'additionalAutoMigrationAttempts',
      'autoMigrationTableName',
      ['autoMigrationTableCreationDDLFile', { supportedVersions: [WLS14] }],
      ['autoMigrationTableCreationPolicy', { supportedVersions: [WLS14] }],
      'candidateMachinesForMigratableServers',
      'dataSourceForAutomaticMigration',
      'databaseLeasingBasisConnectionRetryCount',
      'databaseLeasingBasisConnectionRetryDelay',
      'fencingGracePeriodMillis',
      'healthCheckIntervalMillis',
      'healthCheckPeriodsUntilFencing',
      'interClusterCommLinkHealthCheckInterval',
      'memberDeathDetectorEnabled',
      'migrationBasis',
      'millisToSleepBetweenAutoMigrationAttempts',
      'serviceActivationRequestResponseTimeout',
      'serviceAgeThresholdSeconds',
      'singletonServiceRequestTimeout',
      'unicastReadTimeout',
    ],
  }),
  endpoint({
    id: 'cluster.replication',
    resourceKind: 'cluster',
    sectionId: 'replication',
    sectionLabel: 'Replication and Sessions',
    endpointKind: 'root',
    pathTemplate: '/edit/clusters/{clusterName}',
    collectionPathTemplate: '/edit/clusters',
    capabilities: ['create', 'update'],
    fields: [
      'asyncSessionQueueTimeout',
      'clientCertProxyEnabled',
      'greedySessionFlushInterval',
      'maxSecondarySelectionAttempts',
      'messageOrderingEnabled',
      'multicastAddress',
      'multicastBufferSize',
      'multicastDataEncryption',
      'multicastPort',
      'multicastSendDelay',
      'multicastTTL',
      'oneWayRmiForReplicationEnabled',
      'persistSessionsOnShutdown',
      ['rebalanceDelayPeriods', { supportedVersions: [WLS14] }],
      'remoteClusterAddress',
      'replicationChannel',
      'replicationTimeoutEnabled',
      ['replicationTimeoutMillis', { supportedVersions: [WLS14] }],
      'secureReplicationEnabled',
      'sessionFlushInterval',
      'sessionFlushThreshold',
      'sessionLazyDeserializationEnabled',
      'sessionStateQueryProtocolEnabled',
      'sessionStateQueryRequestTimeout',
      'WANSessionPersistenceTableName',
    ],
  }),
  endpoint({
    id: 'cluster.scheduler',
    resourceKind: 'cluster',
    sectionId: 'jta-scheduler',
    sectionLabel: 'JTA and Scheduler',
    endpointKind: 'root',
    pathTemplate: '/edit/clusters/{clusterName}',
    collectionPathTemplate: '/edit/clusters',
    capabilities: ['create', 'update'],
    fields: [
      'coherenceClusterSystemResource',
      'concurrentSingletonActivationEnabled',
      'dataSourceForJobScheduler',
      'dataSourceForSessionPersistence',
      'httpTraceSupportEnabled',
      'idlePeriodsUntilTimeout',
      'jobSchedulerTableName',
      'memberWarmupTimeoutSeconds',
      'txnAffinityEnabled',
    ],
  }),
  endpoint({
    id: 'cluster.dynamicServers',
    resourceKind: 'cluster',
    sectionId: 'dynamic-servers',
    sectionLabel: 'Dynamic Servers',
    endpointKind: 'singleton-child',
    pathTemplate: '/edit/clusters/{clusterName}/dynamicServers',
    fields: [
      'name',
      'calculatedListenPorts',
      'calculatedMachineNames',
      'dynamicClusterCooloffPeriodSeconds',
      'dynamicClusterShutdownTimeoutSeconds',
      'dynamicClusterSize',
      'dynamicServerNames',
      'ignoreSessionsDuringShutdown',
      'machineMatchExpression',
      'machineMatchType',
      'machineNameMatchExpression',
      'maxDynamicClusterSize',
      'minDynamicClusterSize',
      'serverNamePrefix',
      'serverNameStartingIndex',
      'serverTemplate',
      'waitForAllSessionsDuringShutdown',
    ],
  }),
  endpoint({
    id: 'cluster.jta',
    resourceKind: 'cluster',
    sectionId: 'jta',
    sectionLabel: 'JTA Cluster',
    endpointKind: 'singleton-child',
    pathTemplate: '/edit/clusters/{clusterName}/JTACluster',
    fields: [
      'name',
      'abandonTimeoutSeconds',
      'beforeCompletionIterationLimit',
      'checkpointIntervalSeconds',
      'clusterwideRecoveryEnabled',
      'completionTimeoutSeconds',
      'determinerCandidateResourceInfoList',
      'determiners',
      'forgetHeuristics',
      'localDomainSecurityCacheEnabled',
      'localDomainSecurityCacheTTL',
      'localDomainSecurityEnabled',
      'maxResourceRequestsOnServer',
      'maxResourceUnavailableMillis',
      'maxRetrySecondsBeforeDeterminerFail',
      'maxTransactions',
      'maxUniqueNameStatistics',
      'maxXACallMillis',
      'parallelXADispatchPolicy',
      'parallelXAEnabled',
      'securityInteropMode',
      'serializeEnlistmentsGCIntervalMillis',
      'shutdownGracePeriod',
      'TLOGWriteWhenDeterminerExistsEnabled',
      'tightlyCoupledTransactionsEnabled',
      'timeoutSeconds',
      'twoPhaseEnabled',
      'unregisterResourceGracePeriod',
      'useNonSecureAddressesForDomains',
      'usePublicAddressesForRemoteDomains',
      'WSATIssuedTokenEnabled',
      'WSATTransportSecurityMode',
    ],
  }),
  endpoint({
    id: 'cluster.databaseLessLeasingBasis',
    resourceKind: 'cluster',
    sectionId: 'leasing-migration',
    sectionLabel: 'Database-less Leasing',
    endpointKind: 'singleton-child',
    pathTemplate: '/edit/clusters/{clusterName}/databaseLessLeasingBasis',
    fields: ['name', 'memberDiscoveryTimeout'],
  }),
  endpoint({
    id: 'cluster.overloadProtection',
    resourceKind: 'cluster',
    sectionId: 'overload',
    sectionLabel: 'Overload Protection',
    endpointKind: 'singleton-child',
    pathTemplate: '/edit/clusters/{clusterName}/overloadProtection',
    fields: [
      'name',
      'failureAction',
      'panicAction',
      'freeMemoryPercentHighThreshold',
      'freeMemoryPercentLowThreshold',
      'sharedCapacityForWorkManagers',
    ],
  }),
  endpoint({
    id: 'cluster.serverFailureTrigger',
    resourceKind: 'cluster',
    sectionId: 'overload',
    sectionLabel: 'Server Failure Trigger',
    endpointKind: 'singleton-child',
    pathTemplate: '/edit/clusters/{clusterName}/overloadProtection/serverFailureTrigger',
    fields: [
      'name',
      'maxStuckThreadTime',
      'stuckThreadCount',
      ['heapDumpingOnDeadlock', { supportedVersions: [WLS14] }],
      ['heapDumpingOnMaxStuckThread', { supportedVersions: [WLS14] }],
    ],
  }),
]

export function topologyEndpointSupportsVersion(endpoint: TopologyEndpointCatalog, version: WlsVersion) {
  return endpoint.supportedVersions.includes(version)
}

export function topologyFieldSupportsVersion(field: TopologyFieldMetadata, version: WlsVersion) {
  return field.supportedVersions.includes(version)
}

export function topologyEndpointsFor(resourceKind: TopologyResourceKind, version: WlsVersion) {
  return TOPOLOGY_ENDPOINTS
    .filter((endpoint) => endpoint.resourceKind === resourceKind && topologyEndpointSupportsVersion(endpoint, version))
    .map((endpoint) => ({
      ...endpoint,
      fields: endpoint.fields.filter((field) => topologyFieldSupportsVersion(field, version)),
    }))
}

export function topologyEndpointById(endpointId: string, version?: WlsVersion) {
  const endpoint = TOPOLOGY_ENDPOINTS.find((candidate) => candidate.id === endpointId)
  if (!endpoint) return null
  if (version && !topologyEndpointSupportsVersion(endpoint, version)) return null
  if (!version) return endpoint
  return {
    ...endpoint,
    fields: endpoint.fields.filter((field) => topologyFieldSupportsVersion(field, version)),
  }
}

export function topologySectionsFor(resourceKind: TopologyResourceKind, version: WlsVersion): TopologySectionCatalog[] {
  const endpoints = topologyEndpointsFor(resourceKind, version)
  const byId = new Map<string, TopologySectionCatalog>()
  endpoints.forEach((endpoint) => {
    const existing = byId.get(endpoint.sectionId)
    if (existing) {
      existing.endpointIds.push(endpoint.id)
      existing.fields.push(...endpoint.fields)
      return
    }
    byId.set(endpoint.sectionId, {
      id: endpoint.sectionId,
      resourceKind,
      label: endpoint.sectionLabel,
      endpointIds: [endpoint.id],
      fields: [...endpoint.fields],
    })
  })
  return [...byId.values()]
}

export function topologyEndpointFieldNames(endpoint: Pick<TopologyEndpointCatalog, 'fields'>) {
  return [...new Set(endpoint.fields.map((field) => field.jsonProperty))].join(',')
}

export function fieldSupportsMutation(field: Pick<TopologyFieldMetadata, 'writeSupport'>, mode: 'create' | 'update') {
  if (field.writeSupport === 'unsupported' || field.writeSupport === 'read-only') return false
  if (field.writeSupport === 'create-only') return mode === 'create'
  return true
}
