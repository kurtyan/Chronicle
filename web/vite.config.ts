import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

const serverPort = process.env.CHRONICLE_SERVER_PORT ?? '8083'
const apiTarget = `http://localhost:${serverPort}`

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5175,
    proxy: {
      '/api/events': {
        target: apiTarget,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            proxyReq.setHeader('Connection', 'keep-alive');
            proxyReq.setHeader('Cache-Control', 'no-cache');
          });
        },
      },
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
  },
})
