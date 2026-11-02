import { actionAuditHeaders } from '../action-audit-headers.ts'
import { wlsBasicAuthHeader, type WlsCredentials } from '../client.ts'
import { DEPLOYMENT_FILE_NAME_HEADER, DEPLOYMENT_MODEL_HEADER } from '../deployment-upload-contract.ts'
import type { DeploymentTargetRef } from './deployments.ts'
import { deploymentTargetTuple } from './deployment-targets.ts'

// Deployment name suggested for an uploaded archive: the file name without its extension.
export function deploymentNameFromFileName(fileName: string) {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? ''
  return base.replace(/\.(war|ear|jar|rar)$/i, '')
}

export function deploymentUploadRequestInit(
  creds: WlsCredentials,
  deploymentName: string,
  targets: DeploymentTargetRef[],
  file: Blob & { name: string },
): RequestInit {
  return {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: wlsBasicAuthHeader(creds),
      'Content-Type': 'application/octet-stream',
      [DEPLOYMENT_MODEL_HEADER]: encodeURIComponent(
        JSON.stringify({ name: deploymentName, targets: targets.map((target) => ({ identity: deploymentTargetTuple(target) })) }),
      ),
      [DEPLOYMENT_FILE_NAME_HEADER]: encodeURIComponent(file.name),
      ...actionAuditHeaders(creds),
    },
    body: file,
  }
}

