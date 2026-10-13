import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // The SPA and the API share one origin in development, so the session cookie is first-party (SameSite=Strict)
    // and the browser's Origin header matches the API's WEB_ORIGIN (http://localhost:5173).
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: false } },
  },
  build: { sourcemap: false },
})
