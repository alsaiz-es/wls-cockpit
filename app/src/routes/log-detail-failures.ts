export interface LogDetailFailure {
  serverName: string
  signal: string
  message: string
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export function buildTopLevelLogDetailFailures({
  runtimeFailures,
  metadataFailures,
  metadataError,
  serverName,
}: {
  runtimeFailures: LogDetailFailure[]
  metadataFailures: LogDetailFailure[]
  metadataError: unknown
  serverName: string
}): LogDetailFailure[] {
  const detailError = metadataError
    ? [{ serverName, signal: 'detailMetadata', message: errorMessage(metadataError, 'Unable to load log metadata.') }]
    : []

  return [...runtimeFailures, ...metadataFailures, ...detailError]
}
