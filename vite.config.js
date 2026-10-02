import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],

  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) return 'vendor'
          if (id.includes('node_modules/firebase')) return 'firebase'
        },
      },
    },
  },

  server: {
    proxy: {
      // The BLUSWAN server (npm run server): runtime, provider credentials, persistence. Same origin for the browser.
      '/api': { target: process.env.BLUSWAN_SERVER_URL || 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
})
