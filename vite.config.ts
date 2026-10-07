import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify("0.2.2") },
  server: {
    allowedHosts: ["local.wesbos.com"],
  },
  plugins: [
    react(),
    cloudflare(),
    VitePWA({
      registerType: "prompt",
      manifest: {
        name: "Yard Sale Gold",
        short_name: "Gold",
        description: "Spot valuable finds with GPT-6 Luna.",
        theme_color: "#11110f",
        background_color: "#f4f0e6",
        display: "standalone",
        start_url: "/scan",
        icons: [
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
        ],
      },
      workbox: {
        // Activate the worker so earlier autoUpdate clients can migrate. The new
        // client announces an update and reloads only when the user requests it.
        skipWaiting: true,
        clientsClaim: true,
        navigateFallback: null,
        runtimeCaching: [{
          urlPattern: ({ request }) => request.mode === "navigate",
          handler: "NetworkFirst",
          options: {
            cacheName: "app-pages",
            networkTimeoutSeconds: 5,
            cacheableResponse: { statuses: [200] },
            expiration: { maxEntries: 10 },
          },
        }],
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
      },
    }),
  ],
});
