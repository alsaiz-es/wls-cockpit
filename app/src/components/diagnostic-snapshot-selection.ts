export function selectableThreadDumpServers(availableServers: string[], requestedServers: string[] | undefined) {
  if (!requestedServers?.length) return new Set<string>()
  const available = new Set(availableServers)
  return new Set(
    requestedServers
      .map((server) => server.trim())
      .filter((server) => server.length > 0 && available.has(server)),
  )
}
