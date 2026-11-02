export type DataSourceUtilizationCapacitySource = 'configuredMax' | 'runtimeCurrent'

export interface DataSourceUtilizationInput {
  activeConnectionsCurrentCount: number | null
  configuredMaxCapacity: number | null
  currCapacity: number | null
}

export interface DataSourceUtilizationSummary {
  utilization: number | null
  utilizationCapacity: number | null
  utilizationCapacitySource: DataSourceUtilizationCapacitySource | null
}

function positiveNumber(value: number | null) {
  return value !== null && Number.isFinite(value) && value > 0 ? value : null
}

export function resolveDataSourceUtilization({
  activeConnectionsCurrentCount,
  configuredMaxCapacity,
  currCapacity,
}: DataSourceUtilizationInput): DataSourceUtilizationSummary {
  const configuredCapacity = positiveNumber(configuredMaxCapacity)
  const runtimeCapacity = positiveNumber(currCapacity)
  const utilizationCapacity = configuredCapacity ?? runtimeCapacity
  const utilizationCapacitySource: DataSourceUtilizationCapacitySource | null = configuredCapacity
    ? 'configuredMax'
    : runtimeCapacity
      ? 'runtimeCurrent'
      : null

  return {
    utilization:
      activeConnectionsCurrentCount !== null && utilizationCapacity !== null
        ? activeConnectionsCurrentCount / utilizationCapacity
        : null,
    utilizationCapacity,
    utilizationCapacitySource,
  }
}
