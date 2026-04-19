import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const projectRoot = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(projectRoot, '../web')

export default defineConfig(({ command }) => ({
  plugins: [react()],
  root: webRoot,
  resolve: {
    alias: {
      '@': path.resolve(webRoot, 'src'),
    },
  },
  server: command === 'serve' ? {
    port: 5176,
    proxy: {
      '/api': {
        target: 'http://localhost:8083',
        changeOrigin: true,
        configure: (proxy, _options) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            // Force streaming headers for SSE
            proxyReq.setHeader('Connection', 'keep-alive')
            proxyReq.setHeader('X-Accel-Buffering', 'no')
            // Forward upgrade headers for streaming
            if (req.headers.accept?.includes('text/event-stream')) {
              proxyReq.setHeader('Accept', 'text/event-stream')
              proxyReq.setHeader('Cache-Control', 'no-cache')
            }
          })
        },
      },
    },
  } : undefined,
  build: {
    outDir: path.resolve(projectRoot, 'dist'),
    emptyOutDir: true,
  },
  clearScreen: false,
}))
