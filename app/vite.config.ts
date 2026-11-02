import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import {
  WLS_TARGET_HEADER,
  normalizeWlsTarget,
} from './src/api/proxy-target.ts'
import { defaultWlsVersion, type WlsVersion } from './src/api/wls-version.ts'
import { handleJmsJmxRequest, proxyWlsRequest } from './server/http.ts'

function requestHeader(req: IncomingMessage, name: string) {
  const value = req.headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0]
  return value
}

function requestTarget(req: IncomingMessage, fallbackTarget: string) {
  return requestHeader(req, WLS_TARGET_HEADER) ?? fallbackTarget
}

function sendProxyError(res: ServerResponse, statusCode: number, message: string) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ error: message }))
}

function wlsProxyPlugin(targetUrl: string, defaultVersion: WlsVersion): Plugin {
  return {
    name: 'wls-cockpit-dev-wls-proxy',
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next) => {
        if (!req.url?.startsWith('/api/wls') && !req.url?.startsWith('/api/jms')) {
          next()
          return
        }

        const target = requestTarget(req, targetUrl)
        const handler = req.url.startsWith('/api/jms') ? handleJmsJmxRequest : proxyWlsRequest
        void handler(req, res, { targetUrl: target, defaultVersion }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'Unexpected proxy error.'
          sendProxyError(res, 502, message)
        })
      })
    },
  }
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const configuredTarget = normalizeWlsTarget(env.VITE_WLS_TARGET || 'http://localhost:7001')
  const target = configuredTarget.ok ? configuredTarget.targetUrl : 'http://localhost:7001'
  const defaultVersion = defaultWlsVersion(env.VITE_WLS_DEFAULT_VERSION)

  return {
    // Packaged runs read their defaults from the server-injected runtime config. Keep
    // VITE_* values from a local .env (lab targets) out of production bundles.
    envPrefix: command === 'build' ? 'WLS_COCKPIT_BUILD_' : 'VITE_',
    plugins: [wlsProxyPlugin(target, defaultVersion), react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  }
})
