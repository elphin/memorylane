import { defineConfig } from 'vitest/config'

// Node-omgeving: Node 20+ heeft WebCrypto (crypto.subtle) globaal, inclusief
// HKDF + AES-GCM — precies wat de PWA in de browser gebruikt.
export default defineConfig({
  test: { environment: 'node' },
})
