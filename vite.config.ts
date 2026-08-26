import { defineConfig } from 'vite'

// GitHub Pages serves a project site from a sub-path, so builds need a base.
// Override with VITE_BASE=/ when deploying to a root domain.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/sabine/',
  build: { target: 'es2022', assetsInlineLimit: 0 },
  worker: { format: 'es' },
})
