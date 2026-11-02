export interface DeploymentDataSourceFilterRow {
  serverName: string
  name: string
  deploymentName: string
}

export function deploymentDataSourceKey(serverName: string, name: string) {
  return `${serverName}:${name}`
}

export function filterDeploymentDataSourceRows<Row extends DeploymentDataSourceFilterRow>(
  rows: Row[],
  dataSourceNamesByServer: ReadonlyMap<string, ReadonlySet<string>>,
) {
  return rows.filter((row) => {
    const dataSourceNames = dataSourceNamesByServer.get(row.serverName)
    if (!dataSourceNames) return true
    return !(
      dataSourceNames.has(deploymentDataSourceKey(row.serverName, row.name)) ||
      dataSourceNames.has(deploymentDataSourceKey(row.serverName, row.deploymentName))
    )
  })
}
