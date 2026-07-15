/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// MemoryLane Onderweg — de telefoon-PWA.
// - Service worker: app-shell precache (opent ook zonder bereik → concepten
//   blijven), maar NOOIT /api/* of R2-URLs cachen (network-only).
// - Manifest: installeerbaar, standalone, terracotta thema.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        // /api/* en presigned R2-URLs mogen NOOIT uit de cache komen.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
      manifest: {
        name: 'MemoryLane',
        short_name: 'MemoryLane',
        description: 'Leg onderweg een herinnering vast voor MemoryLane.',
        lang: 'nl',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#171412',
        theme_color: '#B4552D',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
    }),
  ],
  test: { environment: 'node' },
})
