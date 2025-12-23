import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5199,
    watch: {
      // Voorkom restarts door deze bestanden te negeren
      ignored: ['**/node_modules/**', '**/src-tauri/**', '**/.git/**'],
    },
    hmr: {
      // Overlay uitschakelen voorkomt dat fouten de pagina blokkeren
      overlay: true,
    },
  },
  build: {
    target: 'esnext',
  },
})
