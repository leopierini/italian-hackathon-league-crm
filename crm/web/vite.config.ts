import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Built into crm/public, served by Fastify on the same origin as the API.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, "../public"),
    emptyOutDir: true,
  },
  server: {
    proxy: { "/ui-api": "http://localhost:3000", "/crm": "http://localhost:3000" },
  },
})
