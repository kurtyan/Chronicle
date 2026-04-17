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
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  } : undefined,
  build: {
    outDir: path.resolve(projectRoot, 'dist'),
    emptyOutDir: true,
  },
  clearScreen: false,
}))
