import { defineConfig } from 'vite'

export default defineConfig({
  publicDir: false,
  // The published package has no runtime dependencies: the YAML parser for alerts.yaml is bundled.
  ssr: { noExternal: ['yaml'] },
  build: {
    emptyOutDir: true,
    outDir: 'dist-server',
    ssr: 'server/cli.ts',
    rollupOptions: {
      output: {
        banner: '#!/usr/bin/env node',
        entryFileNames: 'wls-cockpit.mjs',
      },
    },
  },
})
