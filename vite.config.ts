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

// Mirrors the headers nginx serves in production (deploy/nginx.conf) so dev,
// `npm run preview` and the e2e suites all run under the same policy — a CSP
// that broke the app would otherwise only show up after a deploy.
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
}

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
        // Ember theme (the default) light background — see src/lib/themes
        theme_color: "#FAF7F1",
        background_color: "#FAF7F1",
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
        navigateFallbackDenylist: [
          /^\/api\//,
          /^\/splash\//,
          // Same-origin login pages of common auth gateways (oauth2-proxy,
          // traefik-forward-auth, Authentik, Pomerium). reloginViaProxy
          // (src/lib/sw.ts) drops the worker and reloads; the proxy then 302s
          // that navigation through one of these. With the worker gone the
          // fetch reaches the network regardless, but keeping them off the
          // fallback means the worker that re-registers on the next boot
          // never serves the cached shell in place of the gateway's page.
          /^\/oauth2\//,
          /^\/_oauth/,
          /^\/outpost\.goauthentik\.io\//,
          /^\/\.pomerium\//,
        ],
        cleanupOutdatedCaches: true,
        // The plugin only turns this on for autoUpdate mode. In prompt mode
        // a freshly-activated worker would otherwise leave already-open pages
        // (and iOS standalone launches that come up uncontrolled) unclaimed,
        // so the controllerchange that applyUpdate (src/lib/sw.ts) reloads on
        // would never fire for them.
        clientsClaim: true,
      },
    }),
  ],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    headers: SECURITY_HEADERS,
    proxy: {
      // Same-origin proxy for Ollama cloud (ollama.com has no CORS support).
      // In production the bundled nginx config provides the same route.
      "/api/ollama": {
        target: "https://ollama.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/ollama/, ""),
      },
      // The cloud turn runner — run `node server/cloud.mjs` alongside dev.
      // Without it the probe fails quietly and the Local/Cloud pill hides.
      "/api/cloud": {
        target: `http://127.0.0.1:${process.env.KILN_CLOUD_PORT ?? 8090}`,
      },
    },
  },
  preview: {
    headers: SECURITY_HEADERS,
    proxy: {
      "/api/ollama": {
        target: "https://ollama.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/ollama/, ""),
      },
      "/api/cloud": {
        target: `http://127.0.0.1:${process.env.KILN_CLOUD_PORT ?? 8090}`,
      },
    },
  },
})
