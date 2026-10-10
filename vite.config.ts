import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** Tizen loads the app from local files, where module scripts are refused, so
 * the TV build is one classic script. */
function classicScript(): Plugin {
  return {
    name: "finplay-classic-script",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler: (html) => html.replace(/<script type="module" crossorigin/g, "<script defer"),
    },
  };
}

export default defineConfig(({ mode }) => {
  const tv = mode === "tv";
  return {
    base: tv ? "./" : "/",
    plugins: [react(), tv ? classicScript() : null],
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
      // The TV dev loader reaches the dev server over the local network.
      host: tv ? "0.0.0.0" : "127.0.0.1",
      watch: {
        ignored: ["**/src-tauri/**"],
      },
    },
    envPrefix: ["VITE_", "TAURI_"],
    build: tv
      ? {
          // Samsung's 2022 TVs (Tizen 6.5) run Chromium 85.
          target: "chrome85",
          cssTarget: "chrome85",
          outDir: "dist-tv",
          sourcemap: false,
          modulePreload: false,
          rollupOptions: { output: { format: "iife", inlineDynamicImports: true } },
        }
      : {
          target: "esnext",
          sourcemap: false,
        },
  };
});
