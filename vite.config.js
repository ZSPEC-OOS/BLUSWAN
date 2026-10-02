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
          if (id.includes('node_modules/ogl')) return 'ogl'
        },
      },
    },
  },

  server: {
    proxy: {
      // The BLUSWAN server (npm run server): runtime, provider credentials, persistence. Same origin for the browser.
      '/api/stream': { target: process.env.BLUSWAN_SERVER_URL || 'http://127.0.0.1:8787', changeOrigin: false, ws: false },
      '^/api/(?!proxy/).*': { target: process.env.BLUSWAN_SERVER_URL || 'http://127.0.0.1:8787', changeOrigin: false },
      // Legacy: proxy external AI API calls through Vite's Node server to avoid CORS
      '/api/proxy/moonshot': {
        target: 'https://api.moonshot.cn',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/proxy\/moonshot/, '/v1'),
      },
      '/api/proxy/anthropic': {
        target: 'https://api.anthropic.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/proxy\/anthropic/, '/v1'),
      },
      '/api/proxy/openai': {
        target: 'https://api.openai.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/proxy\/openai/, '/v1'),
      },
      // Gemini uses Google's OpenAI-compatible endpoint (/v1beta/openai/...)
      '/api/proxy/gemini': {
        target: 'https://generativelanguage.googleapis.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/proxy\/gemini/, '/v1beta/openai'),
      },
      // ââ New providers âââââââââââââââââââââââââââââââââââââââââââââââââââââ
      '/api/proxy/groq': {
        target: 'https://api.groq.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/proxy\/groq/, '/openai/v1'),
      },
      '/api/proxy/mistral': {
        target: 'https://api.mistral.ai',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/proxy\/mistral/, '/v1'),
      },
      '/api/proxy/codestral': {
        target: 'https://codestral.mistral.ai',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/proxy\/codestral/, '/v1'),
      },
      '/api/proxy/deepseek': {
        target: 'https://api.deepseek.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/proxy\/deepseek/, '/v1'),
      },
      '/api/proxy/xai': {
        target: 'https://api.x.ai',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/proxy\/xai/, '/v1'),
      },
      '/api/proxy/openrouter': {
        target: 'https://openrouter.ai',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/proxy\/openrouter/, '/api/v1'),
      },
      '/api/proxy/tavily': {
        target: 'https://api.tavily.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/proxy\/tavily/, ''),
      },
    },
  },
})
