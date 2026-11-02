import { defineConfig } from 'vite'

export default defineConfig({
  publicDir: false,
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
