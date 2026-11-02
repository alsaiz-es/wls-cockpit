// The Cockpit version from package.json, injected by Vite at build time (vite.config.ts `define`).
declare const __WLS_COCKPIT_VERSION__: string | undefined

export const APP_VERSION = typeof __WLS_COCKPIT_VERSION__ === 'string' ? __WLS_COCKPIT_VERSION__ : 'dev'
