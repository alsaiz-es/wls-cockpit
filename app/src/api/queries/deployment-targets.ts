import type { DeploymentTargetKind, DeploymentTargetRef } from './deployments'

function targetKindLabel(kind: DeploymentTargetKind) {
  return kind === 'servers' ? 'server' : 'cluster'
}

export function deploymentTargetKey(target: DeploymentTargetRef) {
  return `${target.kind}:${target.name}`
}

export function deploymentTargetLabel(target: DeploymentTargetRef) {
  return `${targetKindLabel(target.kind)}:${target.name}`
}

export function deploymentTargetTuple(target: DeploymentTargetRef): [DeploymentTargetKind, string] {
  return [target.kind, target.name]
}
