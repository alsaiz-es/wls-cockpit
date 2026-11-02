import { WLS_TARGET_HEADER } from './proxy-target.ts'
import type { WlsCredentials } from './client.ts'

export const AUDIT_PROFILE_ID_HEADER = 'x-wls-cockpit-profile-id'
export const AUDIT_PROFILE_NAME_HEADER = 'x-wls-cockpit-profile-name'
export const AUDIT_USERNAME_HEADER = 'x-wls-cockpit-username'
export const AUDIT_VERSION_HEADER = 'x-wls-cockpit-version'

export function actionAuditHeaders(creds: WlsCredentials) {
  return {
    [AUDIT_PROFILE_ID_HEADER]: creds.profileId,
    [AUDIT_PROFILE_NAME_HEADER]: creds.name,
    [AUDIT_USERNAME_HEADER]: creds.username,
    [AUDIT_VERSION_HEADER]: creds.version,
    [WLS_TARGET_HEADER]: creds.targetUrl,
  }
}
