/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dev proxy: the frontend calls fetch('/api/...') and Vite forwards it to
// the FastAPI backend, so there's no CORS setup to maintain and the same
// relative paths work in dev and in any future built/served deployment.
// PROPBT_API_PORT points the proxy at a backend on another port (default 8000),
// so a second dev stack can run beside the usual one.
const apiPort = process.env.PROPBT_API_PORT ?? '8000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
  // happy-dom (not the vitest default 'node') so tests exercise a real
  // localStorage -- several stores (tradeStore, uiStore, indicatorStore)
  // persist via zustand's `persist` middleware as of Phase V7. (jsdom was
  // tried first but its current version has an ESM/CJS interop bug with
  // this Node version; happy-dom is lighter and works.)
  test: {
    environment: 'happy-dom',
  },
})
