import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, historyApiFallback: true },
  // browserWasmWorker.ts (issue #177) dynamically imports wasm_exec.js, which
  // needs the worker bundle to code-split — the default "iife" format can't.
  worker: { format: "es" },
});
