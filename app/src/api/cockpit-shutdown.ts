// Must match SHUTDOWN_PATH / SHUTDOWN_HEADER in server/http.ts.
const SHUTDOWN_PATH = '/__wls-cockpit/shutdown'
const SHUTDOWN_HEADER = 'X-WLS-Cockpit-Shutdown'

export async function requestCockpitShutdown(fetcher: typeof fetch = fetch) {
  const response = await fetcher(SHUTDOWN_PATH, { method: 'POST', headers: { [SHUTDOWN_HEADER]: 'confirm' } })
  if (response.status !== 202) throw new Error(`Cockpit did not stop (HTTP ${response.status}).`)
}
