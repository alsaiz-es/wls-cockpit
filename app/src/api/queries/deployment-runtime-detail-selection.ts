export const DEPLOYMENT_RUNTIME_FIELDS =
  'name,applicationName,applicationVersion,internal,healthState,overallHealthState,activeVersionState,deploymentState'
export const DEPLOYMENT_CONFIG_FIELDS =
  'name,applicationName,targets,moduleType,deploymentOrder,sourcePath,planPath,securityDDModel,stagingMode'

export function deploymentConfigQueryParams() {
  return {
    fields: DEPLOYMENT_CONFIG_FIELDS,
    links: 'none',
  } as const
}

export function deploymentRuntimeQueryParams() {
  return {
    fields: DEPLOYMENT_RUNTIME_FIELDS,
    links: 'none',
  } as const
}

export function deploymentRuntimeDetailCandidates(deploymentName: string, configApplicationName: string | null) {
  return [deploymentName, configApplicationName].filter(
    (value, index, candidates): value is string =>
      typeof value === 'string' && value.length > 0 && candidates.indexOf(value) === index,
  )
}
