import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dataSourceDriverPreset,
  defaultUrlTemplateFields,
  deriveDataSourceUrl,
  matchDataSourceDriverPreset,
  parseDataSourcePresetUrl,
} from '../src/api/queries/data-source-driver-presets.ts'

test('oracle service preset derives and parses service URLs', () => {
  const preset = dataSourceDriverPreset('oracle-thin-service')

  assert.equal(preset.driverName, 'oracle.jdbc.OracleDriver')
  assert.equal(preset.defaultTestTableName, 'SQL ISVALID')
  assert.equal(
    deriveDataSourceUrl('oracle-thin-service', { host: 'scan.example.com', port: '1521', service: 'PDB1' }),
    'jdbc:oracle:thin:@//scan.example.com:1521/PDB1',
  )
  assert.deepEqual(parseDataSourcePresetUrl('oracle-thin-service', 'jdbc:oracle:thin:@//scan.example.com:1521/PDB1'), {
    host: 'scan.example.com',
    port: '1521',
    service: 'PDB1',
  })
})

test('oracle sid preset derives and parses sid URLs', () => {
  assert.equal(
    deriveDataSourceUrl('oracle-thin-sid', { host: 'dbhost', port: '1522', sid: 'ORCL' }),
    'jdbc:oracle:thin:@dbhost:1522:ORCL',
  )
  assert.deepEqual(parseDataSourcePresetUrl('oracle-thin-sid', 'jdbc:oracle:thin:@dbhost:1522:ORCL'), {
    host: 'dbhost',
    port: '1522',
    sid: 'ORCL',
  })
})

test('matching unknown or complex URLs keeps a preset but leaves URL manual', () => {
  const racUrl = 'jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=scan)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=PDB1)))'

  assert.equal(matchDataSourceDriverPreset('oracle.jdbc.OracleDriver', racUrl).id, 'oracle-thin-service')
  assert.equal(parseDataSourcePresetUrl('oracle-thin-service', racUrl), null)
  assert.equal(matchDataSourceDriverPreset('com.vendor.Driver', 'jdbc:vendor://host/db').id, 'custom')
})

test('default template fields include declared defaults only', () => {
  assert.deepEqual(defaultUrlTemplateFields(dataSourceDriverPreset('oracle-thin-service')), {
    host: '',
    port: '1521',
    service: '',
  })
})
