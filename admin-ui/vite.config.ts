import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
  build: {
    rolldownOptions: {
      output: {
        // Split heavy vendor libraries into their own cacheable chunks so
        // no single chunk (the eager entry in particular) exceeds Vite's
        // 500 kB minified-chunk warning limit. Library code changes rarely,
        // so these chunks also stay cached across app-code releases.
        codeSplitting: {
          groups: [
            {
              name: "vendor-react",
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            },
            {
              name: "vendor-motion",
              test: /node_modules[\\/](framer-motion|motion)[\\/]/,
            },
            // NOTE: no echarts group on purpose — ECharts' internal circular
            // module graph must stay in one chunk (arbitrary maxSize splits
            // throw "c is not a constructor" at init). It naturally lands in
            // the lazy SankeyDiagram chunk, which is under the 500 kB limit.
          ],
        },
      },
    },
  },
})
