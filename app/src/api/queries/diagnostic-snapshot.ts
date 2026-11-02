import type { WlsCredentials } from '../client.ts'
import { fetchClusterSnapshot } from './clusters.ts'
import { fetchDataSourceConfigs, fetchDataSourcesSnapshot } from './data-sources.ts'
import { fetchDeploymentsSnapshot } from './deployments.ts'
import { fetchDomainDashboardSnapshot } from './domain-dashboard.ts'
import { fetchJmsSnapshot } from './jms.ts'
import { fetchJtaSnapshot } from './jta.ts'
import {
  applyLogArchiveSummaries,
  fetchLogArchiveSummaries,
  fetchLogRecordPreview,
  fetchLogsSnapshot,
} from './logs.ts'
import { fetchNodeManagerSnapshot } from './node-manager.ts'
import { fetchServerThreadDump } from './server-diagnostics.ts'
import {
  DIAGNOSTIC_SNAPSHOT_MAX_LOG_SOURCES,
  buildDiagnosticSnapshotManifest,
  createStoredZip,
  redactDiagnosticSnapshotString,
  redactDiagnosticSnapshotValue,
  safeDiagnosticSnapshotFilePart,
  truncateDiagnosticSnapshotText,
  type DiagnosticSnapshotBundle,
  type DiagnosticSnapshotFile,
  type DiagnosticSnapshotManifestSection,
  type DiagnosticSnapshotOptions,
} from './diagnostic-snapshot-model.ts'

export {
  DIAGNOSTIC_SNAPSHOT_MAX_LOG_SOURCES,
  DIAGNOSTIC_SNAPSHOT_MAX_TEXT_BYTES,
  DIAGNOSTIC_SNAPSHOT_SCHEMA_VERSION,
  buildDiagnosticSnapshotManifest,
  createStoredZip,
  diagnosticSnapshotTargetLabel,
  redactDiagnosticSnapshotString,
  redactDiagnosticSnapshotValue,
  safeDiagnosticSnapshotFilePart,
  truncateDiagnosticSnapshotText,
  type DiagnosticSnapshotBundle,
  type DiagnosticSnapshotFile,
  type DiagnosticSnapshotManifest,
  type DiagnosticSnapshotManifestSection,
  type DiagnosticSnapshotOptions,
} from './diagnostic-snapshot-model.ts'

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown error'
}

function jsonFile(path: string, value: unknown): DiagnosticSnapshotFile {
  return {
    path,
    text: `${JSON.stringify(redactDiagnosticSnapshotValue(value), null, 2)}\n`,
  }
}

async function sectionFile(
  id: string,
  file: string,
  collect: () => Promise<unknown>,
): Promise<{ file: DiagnosticSnapshotFile | null; section: DiagnosticSnapshotManifestSection }> {
  try {
    const value = await collect()
    return {
      file: jsonFile(file, value),
      section: { id, file, status: 'included' },
    }
  } catch (error) {
    return {
      file: null,
      section: { id, file: null, status: 'failed', error: errorMessage(error) },
    }
  }
}

async function collectRecentLogs(
  creds: WlsCredentials,
  logs: Awaited<ReturnType<typeof fetchLogsSnapshot>>,
  summaries: Awaited<ReturnType<typeof fetchLogArchiveSummaries>>,
) {
  const rows = applyLogArchiveSummaries(logs.rows, summaries.archivesByServer)
  const sources = rows
    .flatMap((row) =>
      row.archives
        .filter((archive) => archive.name === 'ServerLog')
        .map((archive) => ({ serverName: row.serverName, archive })),
    )
    .slice(0, DIAGNOSTIC_SNAPSHOT_MAX_LOG_SOURCES)
  const outcomes = await Promise.allSettled(
    sources.map((source) => fetchLogRecordPreview(creds, source.serverName, source.archive)),
  )

  return {
    sources: outcomes.map((outcome, index) => ({
      serverName: sources[index]?.serverName ?? 'unknown',
      archiveName: sources[index]?.archive.name ?? 'unknown',
      status: outcome.status,
      records: outcome.status === 'fulfilled' ? outcome.value.records : [],
      error: outcome.status === 'rejected' ? errorMessage(outcome.reason) : null,
    })),
  }
}

async function collectThreadDumps(creds: WlsCredentials, serverNames: string[]) {
  const uniqueServerNames = Array.from(new Set(serverNames.map((serverName) => serverName.trim()).filter(Boolean)))
  const outcomes = await Promise.allSettled(uniqueServerNames.map((serverName) => fetchServerThreadDump(creds, serverName)))
  return outcomes.map((outcome, index) => ({
    serverName: uniqueServerNames[index] ?? 'unknown',
    status: outcome.status,
    dump: outcome.status === 'fulfilled'
      ? {
          serverName: outcome.value.serverName,
          capturedAt: outcome.value.capturedAt,
          lineCount: outcome.value.lineCount,
          bytes: outcome.value.bytes,
          text: truncateDiagnosticSnapshotText(redactDiagnosticSnapshotString(outcome.value.text)),
        }
      : null,
    error: outcome.status === 'rejected' ? errorMessage(outcome.reason) : null,
  }))
}

export async function collectDiagnosticSnapshotFiles(
  creds: WlsCredentials,
  options: DiagnosticSnapshotOptions = {},
) {
  const sections = await Promise.all([
    sectionFile('dashboard', 'runtime/dashboard.json', () => fetchDomainDashboardSnapshot(creds)),
    sectionFile('clusters', 'runtime/clusters.json', () => fetchClusterSnapshot(creds)),
    sectionFile('node-manager', 'runtime/node-manager.json', () => fetchNodeManagerSnapshot(creds)),
    sectionFile('jms', 'runtime/jms.json', () => fetchJmsSnapshot(creds)),
    sectionFile('jta', 'runtime/jta.json', () => fetchJtaSnapshot(creds)),
    sectionFile('logs', 'runtime/logs.json', async () => {
      const [logs, archiveSummaries] = await Promise.all([
        fetchLogsSnapshot(creds),
        fetchLogArchiveSummaries(creds),
      ])
      const recent = await collectRecentLogs(creds, logs, archiveSummaries)
      return {
        ...logs,
        archivesByServer: Object.fromEntries(archiveSummaries.archivesByServer),
        archivePartialFailures: archiveSummaries.partialFailures,
        recent,
      }
    }),
    sectionFile('data-sources', 'runtime/data-sources.json', async () => {
      const configs = await fetchDataSourceConfigs(creds)
      const snapshot = await fetchDataSourcesSnapshot(creds, configs.configs)
      return { ...snapshot, configFailures: configs.failures }
    }),
    sectionFile('deployments', 'runtime/deployments.json', async () => ({
      ...(await fetchDeploymentsSnapshot(creds, new Map(), new Map())),
      configDiscovery: 'omitted from diagnostic snapshot export to keep request fan-out bounded',
    })),
    options.includeThreadDumps && options.threadDumpServers?.length
      ? sectionFile('thread-dumps', 'runtime/thread-dumps.json', () => collectThreadDumps(creds, options.threadDumpServers ?? []))
      : Promise.resolve({
          file: null,
          section: { id: 'thread-dumps', file: null, status: 'skipped' as const },
        }),
  ])

  const files = sections.flatMap((entry) => (entry.file ? [entry.file] : []))
  const manifest = buildDiagnosticSnapshotManifest(creds, sections.map((entry) => entry.section))

  return {
    manifest,
    files: [jsonFile('manifest.json', manifest), ...files],
  }
}

export async function createDiagnosticSnapshotBundle(
  creds: WlsCredentials,
  options: DiagnosticSnapshotOptions = {},
): Promise<DiagnosticSnapshotBundle> {
  const snapshot = await collectDiagnosticSnapshotFiles(creds, options)
  const captured = snapshot.manifest.capturedAt.replace(/[:.]/g, '-')
  const filename = `wls-diagnostic-snapshot-${safeDiagnosticSnapshotFilePart(snapshot.manifest.target)}-${captured}.zip`

  return {
    filename,
    manifest: snapshot.manifest,
    blob: createStoredZip(snapshot.files),
  }
}
