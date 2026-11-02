// Shared by the browser and the local server: the browser posts the raw archive to
// DEPLOYMENT_UPLOAD_PATH with the deployment model and the file name in these headers
// (URI-encoded), and the server streams it to WebLogic as a multipart deployment.
export const DEPLOYMENT_UPLOAD_PATH = '/api/deployments/upload'
export const DEPLOYMENT_MODEL_HEADER = 'X-WLS-Cockpit-Deployment-Model'
export const DEPLOYMENT_FILE_NAME_HEADER = 'X-WLS-Cockpit-File-Name'
export const MAX_DEPLOYMENT_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
