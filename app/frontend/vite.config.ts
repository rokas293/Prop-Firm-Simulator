import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dev proxy: the frontend calls fetch('/api/...') and Vite forwards it to
// the FastAPI backend, so there's no CORS setup to maintain and the same
// relative paths work in dev and in any future built/served deployment.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
