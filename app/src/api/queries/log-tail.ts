import type {
  LogRecordPreviewRow,
  LogRecordTailCursor,
  MultiLogTailSource,
  MultiLogTailSourceFailure,
} from './log-runtime-detail-normalization.ts'

// The WLDF search action pages records in ascending order from its starting point. A time window
// (`since`) therefore returns the OLDEST records in the window, which made the tail start minutes
// behind and crawl forward. The action also accepts `fromId` (record id, not combinable with
// `since`) and `query` (WLDF query language), and every data-access runtime reports
// `latestRecordId`, so the tail is anchored on record ids instead.

export interface WldfRecordSearchBody {
  fromId?: number
  since?: string
  until?: string
  limit: number
  query?: string
}

export interface WldfRecordPage {
  records: LogRecordPreviewRow[]
  nextRecordId: number | null
}

export type WldfRecordSearch = (body: WldfRecordSearchBody) => Promise<WldfRecordPage>

export const LOG_TAIL_INITIAL_RECORDS = 50
export const LOG_TAIL_PAGE_SIZE = 500
export const LOG_TAIL_MAX_PAGES = 4
// Record-id spans tried, nearest first, when a severity filter makes matches sparse.
export const LOG_TAIL_FILTERED_SPANS = [2_000, 20_000, 200_000] as const

// WebLogic severity values: lower is more severe (Emergency 1 … Debug 128).
export const LOG_SEVERITY_FLOORS = [
  { value: 'all', label: 'All severities', maxSeverityValue: null },
  { value: 'notice', label: 'Notice and worse', maxSeverityValue: 32 },
  { value: 'warning', label: 'Warning and worse', maxSeverityValue: 16 },
  { value: 'error', label: 'Error and worse', maxSeverityValue: 8 },
] as const

export type LogSeverityFloor = (typeof LOG_SEVERITY_FLOORS)[number]['value']

export function isLogSeverityFloor(value: unknown): value is LogSeverityFloor {
  return LOG_SEVERITY_FLOORS.some((floor) => floor.value === value)
}

// Same floor applied in the browser, for releases whose search action rejects `fromId`/`query`.
export function filterBySeverityFloor(records: LogRecordPreviewRow[], floor: LogSeverityFloor) {
  const maxSeverityValue = LOG_SEVERITY_FLOORS.find((entry) => entry.value === floor)?.maxSeverityValue
  if (!maxSeverityValue) return records
  return records.filter((record) => record.severityValue !== null && record.severityValue <= maxSeverityValue)
}

export function logSeverityQuery(floor: LogSeverityFloor): string | undefined {
  const maxSeverityValue = LOG_SEVERITY_FLOORS.find((entry) => entry.value === floor)?.maxSeverityValue
  return maxSeverityValue ? `SEVERITY_VALUE <= ${maxSeverityValue}` : undefined
}

export interface LogTailRead {
  records: LogRecordPreviewRow[]
  // Records between the previous cursor and this read were not fetched (burst larger than the
  // page budget): the tail jumped to the newest records instead of falling behind.
  skippedAhead: boolean
}

async function pageForward(search: WldfRecordSearch, fromId: number, query: string | undefined) {
  const records: LogRecordPreviewRow[] = []
  let next: number | null = fromId
  for (let page = 0; page < LOG_TAIL_MAX_PAGES && next !== null; page += 1) {
    const result = await search({ fromId: next, limit: LOG_TAIL_PAGE_SIZE, ...(query ? { query } : {}) })
    records.push(...result.records)
    if (result.records.length < LOG_TAIL_PAGE_SIZE || result.nextRecordId === null) {
      return { records, reachedEnd: true }
    }
    next = result.nextRecordId
  }
  return { records, reachedEnd: next === null }
}

async function readNewest(
  search: WldfRecordSearch,
  latestRecordId: number,
  query: string | undefined,
): Promise<LogRecordPreviewRow[]> {
  if (!query) {
    const { records } = await pageForward(search, Math.max(0, latestRecordId - LOG_TAIL_INITIAL_RECORDS + 1), undefined)
    return records.slice(-LOG_TAIL_INITIAL_RECORDS)
  }

  let found: LogRecordPreviewRow[] = []
  for (const span of LOG_TAIL_FILTERED_SPANS) {
    const fromId = Math.max(0, latestRecordId - span)
    const { records } = await pageForward(search, fromId, query)
    found = records
    if (records.length >= LOG_TAIL_INITIAL_RECORDS || fromId === 0) break
  }
  return found.slice(-LOG_TAIL_INITIAL_RECORDS)
}

const PROBE_MAX_REQUESTS = 64

// Some archives report latestRecordId = 0 although they hold records (HTTPAccessLog on 14.1.2 has
// 858 records and reports 0). The last id is then found with one-record searches: exponential
// steps forward, then a binary search; a search from an id returns the first record at or after it.
export async function probeLastRecordId(search: WldfRecordSearch): Promise<number | null> {
  let requests = 0
  const firstAt = async (fromId: number) => {
    requests += 1
    const page = await search({ fromId, limit: 1 })
    const first = page.records[0]
    return first ? (first.recordId ?? fromId) : null
  }

  let low = await firstAt(0)
  if (low === null) return null
  let step = 1024
  let high = low + step
  for (;;) {
    if (requests >= PROBE_MAX_REQUESTS) return low
    const found = await firstAt(high)
    if (found === null) break
    low = found
    step *= 2
    high = low + step
  }
  while (high - low > 1 && requests < PROBE_MAX_REQUESTS) {
    const mid = Math.floor((low + high) / 2)
    const found = await firstAt(mid)
    if (found === null) high = mid
    else low = found
  }
  return low
}

export async function readLogTail(options: {
  search: WldfRecordSearch
  cursor: LogRecordTailCursor | null
  // Fresh `latestRecordId` of the archive; only read when there is no cursor or the tail must
  // jump ahead, so a steady poll costs one search request.
  latestRecordId: () => Promise<number | null>
  query?: string
}): Promise<LogTailRead> {
  const { search, cursor, query } = options

  if (cursor?.latestRecordId !== null && cursor?.latestRecordId !== undefined) {
    const { records, reachedEnd } = await pageForward(search, cursor.latestRecordId + 1, query)
    if (reachedEnd) return { records, skippedAhead: false }
  }

  const reported = await options.latestRecordId()
  const latestRecordId = reported !== null && reported > 0 ? reported : await probeLastRecordId(search)
  if (latestRecordId === null) return { records: [], skippedAhead: false }
  return { records: await readNewest(search, latestRecordId, query), skippedAhead: !!cursor }
}

// A source that fails is not polled again until the operator retries: on 12.2.1.4 a search of
// HTTPAccessLog answers HTTP 500 and writes five error records with stack traces into the server
// log, so retrying it on every poll would flood the very log being tailed.
export function pollableTailSources(sources: MultiLogTailSource[], failures: MultiLogTailSourceFailure[]) {
  const failed = new Set(failures.map((failure) => failure.sourceId))
  return sources.filter((source) => !failed.has(source.id))
}

export function mergeTailFailures(existing: MultiLogTailSourceFailure[], incoming: MultiLogTailSourceFailure[]) {
  const bySource = new Map(existing.map((failure) => [failure.sourceId, failure]))
  incoming.forEach((failure) => bySource.set(failure.sourceId, failure))
  return [...bySource.values()]
}
