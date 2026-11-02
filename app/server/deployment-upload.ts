import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import path from 'node:path'
import { isWlsVersion, type WlsVersion } from '../src/api/wls-version.ts'
import {
  DEPLOYMENT_FILE_NAME_HEADER,
  DEPLOYMENT_MODEL_HEADER,
  MAX_DEPLOYMENT_UPLOAD_BYTES,
} from '../src/api/deployment-upload-contract.ts'

// Deploy by uploading the archive from the operator's machine. The browser sends the raw file as
// the request body and the deployment model in a header (a custom header also forces a CORS
// preflight, so other web pages cannot post here); this server streams it to WebLogic as the
// multipart form POST /management/weblogic/{version}/edit/appDeployments expects ("model" and
// "sourcePath" parts), without buffering the archive in memory.
export {
  DEPLOYMENT_FILE_NAME_HEADER,
  DEPLOYMENT_MODEL_HEADER,
  DEPLOYMENT_UPLOAD_PATH,
  MAX_DEPLOYMENT_UPLOAD_BYTES,
} from '../src/api/deployment-upload-contract.ts'

const ARCHIVE_EXTENSIONS = new Set(['.war', '.ear', '.jar', '.rar'])
const TARGET_KINDS = new Set(['servers', 'clusters'])

export interface DeploymentUploadModel {
  name: string
  targets: Array<{ identity: [string, string] }>
}

export interface DeploymentUploadRequest {
  version: WlsVersion
  model: DeploymentUploadModel
  fileName: string
  size: number
}

export type DeploymentUploadValidation =
  | { ok: true; value: DeploymentUploadRequest }
  | { ok: false; status: number; message: string }

function invalid(message: string, status = 400): DeploymentUploadValidation {
  return { ok: false, status, message }
}

function headerText(req: IncomingMessage, name: string) {
  const value = req.headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function decodeHeader(value: string | undefined) {
  if (!value) return null
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

export function parseDeploymentUploadModel(raw: string | null): DeploymentUploadModel | null {
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (!name || name.length > 255 || /[/\\]/.test(name)) return null
  if (!Array.isArray(record.targets) || record.targets.length === 0) return null
  const targets: DeploymentUploadModel['targets'] = []
  for (const target of record.targets) {
    const identity = typeof target === 'object' && target !== null ? (target as Record<string, unknown>).identity : null
    if (!Array.isArray(identity) || identity.length !== 2) return null
    const [kind, targetName] = identity
    if (typeof kind !== 'string' || !TARGET_KINDS.has(kind)) return null
    if (typeof targetName !== 'string' || !targetName.trim() || /[/\\]/.test(targetName)) return null
    targets.push({ identity: [kind, targetName.trim()] })
  }
  return { name, targets }
}

export function deploymentArchiveFileName(raw: string | null) {
  if (!raw) return null
  const base = path.basename(raw.replace(/\\/g, '/')).trim()
  if (!base || base.length > 255 || /["\r\n]/.test(base)) return null
  return ARCHIVE_EXTENSIONS.has(path.extname(base).toLowerCase()) ? base : null
}

export function validateDeploymentUploadRequest(req: IncomingMessage, searchParams: URLSearchParams): DeploymentUploadValidation {
  const version = searchParams.get('version')
  if (!isWlsVersion(version)) return invalid('Unsupported WebLogic REST version.')
  const model = parseDeploymentUploadModel(decodeHeader(headerText(req, DEPLOYMENT_MODEL_HEADER)))
  if (!model) return invalid('The deployment needs a name and at least one server or cluster target.')
  const fileName = deploymentArchiveFileName(decodeHeader(headerText(req, DEPLOYMENT_FILE_NAME_HEADER)))
  if (!fileName) return invalid('Upload a .war, .ear, .jar or .rar archive.')
  const size = Number(req.headers['content-length'])
  if (!Number.isSafeInteger(size) || size <= 0) return invalid('The archive is empty or its size is unknown.', 411)
  if (size > MAX_DEPLOYMENT_UPLOAD_BYTES) return invalid('The archive is larger than 2 GiB.', 413)
  return { ok: true, value: { version, model, fileName, size } }
}

export function deploymentUploadUpstreamPath(version: WlsVersion) {
  return `/management/weblogic/${version}/edit/appDeployments`
}

export function multipartEnvelope(model: DeploymentUploadModel, fileName: string, boundary = randomBytes(16).toString('hex')) {
  const head = Buffer.from(
    [
      `--${boundary}`,
      'Content-Disposition: form-data; name="model"',
      'Content-Type: application/json',
      '',
      JSON.stringify(model),
      `--${boundary}`,
      `Content-Disposition: form-data; name="sourcePath"; filename="${fileName}"`,
      'Content-Type: application/octet-stream',
      '',
      '',
    ].join('\r\n'),
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return { boundary, head, tail }
}

// The request body framed as one multipart form, read from the client only as fast as WebLogic
// takes it. Fails if the client sends more or fewer bytes than it declared, so the upstream
// Content-Length stays true.
export function multipartBodyStream(req: AsyncIterable<unknown>, head: Buffer, tail: Buffer, declaredSize: number) {
  const chunks = req[Symbol.asyncIterator]()
  let headSent = false
  let received = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headSent) {
        headSent = true
        controller.enqueue(head)
        return
      }
      const next = await chunks.next()
      if (!next.done) {
        const buffer = typeof next.value === 'string' ? Buffer.from(next.value) : (next.value as Buffer)
        received += buffer.byteLength
        if (received > declaredSize) throw new Error('The archive is larger than its declared size.')
        controller.enqueue(buffer)
        return
      }
      if (received !== declaredSize) throw new Error('The archive upload ended early.')
      controller.enqueue(tail)
      controller.close()
    },
    async cancel() {
      await chunks.return?.()
    },
  })
}
