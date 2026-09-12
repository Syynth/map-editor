import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// PROTOTYPE — throwaway. 5176: 5173 is the tour's, 5174 the editor's, 5175 the design mockups'.
export default defineConfig({
  plugins: [react()],
  server: { port: 5176, strictPort: true },
})
