import { readFileSync } from "node:fs"
import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { VitePWA } from "vite-plugin-pwa"
import { licenses } from "./scripts/vite-plugin-licenses"

// Single source of truth for the app version, baked in at build time
// (including docker builds) and shown at the bottom of Settings.
const appVersion = readFileSync(
  path.resolve(__dirname, "VERSION"),
  "utf8",
).trim()

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [
    react(),
    tailwindcss(),
    licenses(__dirname),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["apple-touch-icon.png"],
      manifest: {
        name: "Kiln — AI Chat",
        short_name: "Kiln",
        description:
          "A local-first AI chat app. Your keys, your chats, your device.",
        theme_color: "#faf9f5",
        background_color: "#faf9f5",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        id: "/",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icons/icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
        shortcuts: [
          {
            name: "New chat",
            url: "/?new=1",
            icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
          },
          {
            name: "Images",
            url: "/images",
            icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
          },
        ],
      },
      workbox: {
        importScripts: ["sw-notifications.js"],
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        // iOS reads launch images at add-to-home-screen time, never through
        // the SW — keep the ~2.5 MB of them out of the offline precache
        globIgnores: ["splash/**"],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/splash\//],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    proxy: {
      // Same-origin proxy for Ollama cloud (ollama.com has no CORS support).
      // In production the bundled nginx config provides the same route.
      "/api/ollama": {
        target: "https://ollama.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/ollama/, ""),
      },
      // Agent runner (kiln-agentd) during development — nginx relays the
      // same path in production. ws:true carries the event stream.
      "/agent": { target: "http://localhost:9090", ws: true },
    },
  },
  preview: {
    proxy: {
      "/api/ollama": {
        target: "https://ollama.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/ollama/, ""),
      },
      "/agent": { target: "http://localhost:9090", ws: true },
    },
  },
})
