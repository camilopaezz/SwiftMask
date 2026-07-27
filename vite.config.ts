import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

function getE2EAliases(): Record<string, string> {
  if (process.env.VITE_E2E !== "1") {
    return {};
  }
  return {
    "@tauri-apps/api/core": path.resolve(__dirname, "e2e/mocks/tauri-core.ts"),
    "@tauri-apps/api/event": path.resolve(
      __dirname,
      "e2e/mocks/tauri-event.ts",
    ),
    "@tauri-apps/api/window": path.resolve(
      __dirname,
      "e2e/mocks/tauri-window.ts",
    ),
    "@tauri-apps/plugin-dialog": path.resolve(
      __dirname,
      "e2e/mocks/tauri-plugin-dialog.ts",
    ),
    "@tauri-apps/plugin-opener": path.resolve(
      __dirname,
      "e2e/mocks/tauri-plugin-opener.ts",
    ),
  };
}

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: getE2EAliases(),
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    exclude: ["e2e/**", "**/node_modules/**", "**/dist/**", "**/.opencode/**"],
  },
}));
