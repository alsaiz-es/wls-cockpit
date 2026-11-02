// Shared by the browser and the local server. WebLogic counts every request with a wrong password
// as a failed login, so once it answers 401 the local server stops forwarding those credentials
// (until the next sign-in) and marks its answers with CREDENTIALS_REJECTED_HEADER; the browser
// then signs out instead of polling on.
export const SIGN_IN_HEADER = 'X-WLS-Cockpit-Sign-In'
export const CREDENTIALS_REJECTED_HEADER = 'X-WLS-Cockpit-Credentials-Rejected'
export const CREDENTIALS_REJECTED_CODE = 'CREDENTIALS_REJECTED'
