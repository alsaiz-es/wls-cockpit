export interface DeploymentLifecycleSupportIdentity {
  name: string
  deploymentName: string
  lifecycleSupported: boolean
}

export function deploymentLifecycleSupported(
  row: Pick<DeploymentLifecycleSupportIdentity, 'name' | 'deploymentName'>,
  lifecycleNames: ReadonlySet<string>,
) {
  return lifecycleNames.has(row.deploymentName) || lifecycleNames.has(row.name)
}

export function applyDeploymentLifecycleSupport<Row extends DeploymentLifecycleSupportIdentity>(
  rows: readonly Row[],
  lifecycleNames: ReadonlySet<string>,
): Row[] {
  return rows.map((row) => {
    const lifecycleSupported = deploymentLifecycleSupported(row, lifecycleNames)
    return row.lifecycleSupported === lifecycleSupported ? row : { ...row, lifecycleSupported }
  })
}
