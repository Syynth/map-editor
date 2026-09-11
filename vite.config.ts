import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@editor': fileURLToPath(new URL('./src/editor', import.meta.url)),
    },
  },
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022' },
})
