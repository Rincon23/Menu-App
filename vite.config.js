import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Em dev, encaminha /api pro checador rodando localmente
    // (cd server && npm start) — inclusive o WebSocket do terminal.
    proxy: {
      "/api": { target: "http://localhost:3001", ws: true },
    },
  },
});
