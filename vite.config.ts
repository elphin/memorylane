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
    rollupOptions: {
      output: {
        // PixiJS in een eigen chunk: houdt de app-chunk klein en overzichtelijk
        // (runtime maakt het voor de desktop-app niet uit).
        manualChunks: { pixi: ['pixi.js'] },
      },
    },
    // PixiJS is als één library nu eenmaal ~545 KB; verder opsplitsen heeft
    // geen zin — grens er net boven zodat échte groei wel weer waarschuwt.
    chunkSizeWarningLimit: 600,
  },
})
