// React Router already decodes each path segment and re-encodes only '/' as %2F. Decoding a
// param again turned a literal '%' in a resource name (allowed in WebLogic names) into a
// URIError, so only the slash is restored here.
export function routeParam(value: string | undefined) {
  return value ? value.replace(/%2F/gi, '/') : ''
}
