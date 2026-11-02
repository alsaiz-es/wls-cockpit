export type DataSourceUrlMode = 'template' | 'manual'

export type DataSourceDriverPresetId =
  | 'oracle-thin-service'
  | 'oracle-thin-sid'
  | 'oracle-thin-xa-service'
  | 'custom'

export type DataSourceTransactionProtocol =
  | 'TwoPhaseCommit'
  | 'LoggingLastResource'
  | 'EmulateTwoPhaseCommit'
  | 'OnePhaseCommit'
  | 'None'

export interface DataSourceUrlTemplateField {
  id: string
  label: string
  placeholder: string
  defaultValue?: string
}

export interface DataSourceDriverPreset {
  id: DataSourceDriverPresetId
  label: string
  driverName: string
  useXaDataSourceInterface: boolean | null
  globalTransactionsProtocol: DataSourceTransactionProtocol
  defaultTestTableName: string
  urlFields: DataSourceUrlTemplateField[]
  buildUrl: (fields: Record<string, string>) => string
  parseUrl?: (url: string) => Record<string, string> | null
}

const ORACLE_DRIVER = 'oracle.jdbc.OracleDriver'
const ORACLE_XA_DRIVER = 'oracle.jdbc.xa.client.OracleXADataSource'
const ORACLE_TEST_TABLE = 'SQL ISVALID'

function trimFields(fields: Record<string, string>) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.trim()]))
}

function oraclePort(value: string | undefined) {
  return value?.trim() || '1521'
}

function parseOracleServiceUrl(url: string) {
  const match = url.trim().match(/^jdbc:oracle:thin:@\/\/([^:/\s]+):(\d+)\/(.+)$/i)
  if (!match) return null
  return { host: match[1] ?? '', port: match[2] ?? '', service: match[3] ?? '' }
}

function parseOracleSidUrl(url: string) {
  const match = url.trim().match(/^jdbc:oracle:thin:@([^:/\s]+):(\d+):(.+)$/i)
  if (!match) return null
  return { host: match[1] ?? '', port: match[2] ?? '', sid: match[3] ?? '' }
}

export const DATA_SOURCE_DRIVER_PRESETS: DataSourceDriverPreset[] = [
  {
    id: 'oracle-thin-service',
    label: 'Oracle Thin · Service',
    driverName: ORACLE_DRIVER,
    useXaDataSourceInterface: false,
    globalTransactionsProtocol: 'OnePhaseCommit',
    defaultTestTableName: ORACLE_TEST_TABLE,
    urlFields: [
      { id: 'host', label: 'Host / SCAN', placeholder: 'db-scan.example.com' },
      { id: 'port', label: 'Port', placeholder: '1521', defaultValue: '1521' },
      { id: 'service', label: 'Service', placeholder: 'ORCLPDB1' },
    ],
    buildUrl: (rawFields) => {
      const fields = trimFields(rawFields)
      return `jdbc:oracle:thin:@//${fields.host}:${oraclePort(fields.port)}/${fields.service}`
    },
    parseUrl: parseOracleServiceUrl,
  },
  {
    id: 'oracle-thin-sid',
    label: 'Oracle Thin · SID',
    driverName: ORACLE_DRIVER,
    useXaDataSourceInterface: false,
    globalTransactionsProtocol: 'OnePhaseCommit',
    defaultTestTableName: ORACLE_TEST_TABLE,
    urlFields: [
      { id: 'host', label: 'Host', placeholder: 'dbhost.example.com' },
      { id: 'port', label: 'Port', placeholder: '1521', defaultValue: '1521' },
      { id: 'sid', label: 'SID', placeholder: 'ORCL' },
    ],
    buildUrl: (rawFields) => {
      const fields = trimFields(rawFields)
      return `jdbc:oracle:thin:@${fields.host}:${oraclePort(fields.port)}:${fields.sid}`
    },
    parseUrl: parseOracleSidUrl,
  },
  {
    id: 'oracle-thin-xa-service',
    label: 'Oracle Thin XA · Service',
    driverName: ORACLE_XA_DRIVER,
    useXaDataSourceInterface: true,
    globalTransactionsProtocol: 'TwoPhaseCommit',
    defaultTestTableName: ORACLE_TEST_TABLE,
    urlFields: [
      { id: 'host', label: 'Host / SCAN', placeholder: 'db-scan.example.com' },
      { id: 'port', label: 'Port', placeholder: '1521', defaultValue: '1521' },
      { id: 'service', label: 'Service', placeholder: 'ORCLPDB1' },
    ],
    buildUrl: (rawFields) => {
      const fields = trimFields(rawFields)
      return `jdbc:oracle:thin:@//${fields.host}:${oraclePort(fields.port)}/${fields.service}`
    },
    parseUrl: parseOracleServiceUrl,
  },
  {
    id: 'custom',
    label: 'Custom driver',
    driverName: '',
    useXaDataSourceInterface: null,
    globalTransactionsProtocol: 'OnePhaseCommit',
    defaultTestTableName: '',
    urlFields: [],
    buildUrl: () => '',
  },
]

export function dataSourceDriverPreset(id: string | null | undefined) {
  return DATA_SOURCE_DRIVER_PRESETS.find((preset) => preset.id === id) ?? DATA_SOURCE_DRIVER_PRESETS[0]
}

export function defaultUrlTemplateFields(preset: DataSourceDriverPreset) {
  return Object.fromEntries(preset.urlFields.map((field) => [field.id, field.defaultValue ?? '']))
}

export function deriveDataSourceUrl(presetId: DataSourceDriverPresetId, fields: Record<string, string>) {
  const preset = dataSourceDriverPreset(presetId)
  return preset.buildUrl(fields)
}

export function matchDataSourceDriverPreset(driverName: string | null | undefined, url: string | null | undefined) {
  const normalizedDriver = driverName?.trim()
  if (!normalizedDriver) return DATA_SOURCE_DRIVER_PRESETS[0]
  const matches = DATA_SOURCE_DRIVER_PRESETS.filter((preset) => preset.id !== 'custom' && preset.driverName === normalizedDriver)
  if (matches.length === 0) return dataSourceDriverPreset('custom')
  const urlText = url?.trim() ?? ''
  return matches.find((preset) => !!preset.parseUrl?.(urlText)) ?? matches[0] ?? dataSourceDriverPreset('custom')
}

export function parseDataSourcePresetUrl(presetId: DataSourceDriverPresetId, url: string | null | undefined) {
  const preset = dataSourceDriverPreset(presetId)
  return preset.parseUrl?.(url?.trim() ?? '') ?? null
}
