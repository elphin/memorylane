import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// De versie leeft op één plek: src-tauri/tauri.conf.json (die stuurt ook de installer
// aan). We injecteren 'm hier als __APP_VERSION__ zodat de "over"-tekst in de app
// automatisch meeloopt — geen los versienummer meer bijwerken. In de échte desktop-app
// leest getVersion() de bundle-versie; dit is de betrouwbare fallback voor browser-dev.
const tauriConf = JSON.parse(
  readFileSync(fileURLToPath(new URL('./src-tauri/tauri.conf.json', import.meta.url)), 'utf-8'),
) as { version?: string }
const APP_VERSION = tauriConf.version ?? '0.0.0'

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
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
