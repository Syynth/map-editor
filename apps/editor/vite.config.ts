import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: {
    target: 'es2022',
    rolldownOptions: {
      output: {
        // Vite 8 runs on Rolldown: manual chunking moved from
        // `output.manualChunks` to `output.codeSplitting.groups` (a boolean
        // `manualChunks` fn is deprecated and silently ignored once this is
        // set). Without these groups, three + its postprocessing subpaths
        // and react/react-dom land in the single entry chunk, which trips
        // Vite's 500 kB warning (see #29). `[\\/]` (not `/`) in the test
        // regexes so matching stays correct on Windows paths.
        codeSplitting: {
          groups: [
            {
              name: 'vendor-three',
              // Matches both `three` itself and the
              // `three/examples/jsm/postprocessing/*` passes the viewport
              // pulls in — both resolve under node_modules/three/. three's
              // core alone minifies past 500 kB, so `maxSize` tells rolldown
              // to slice this group into several near-equal chunks instead
              // of leaving one oversized `vendor-three` chunk.
              test: /node_modules[\\/]three[\\/]/,
              maxSize: 350_000,
            },
            {
              name: 'vendor-react',
              // react-dom depends on scheduler; group it with react so the
              // vendor-react chunk stays self-contained.
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            },
          ],
        },
      },
    },
  },
})
