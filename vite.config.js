import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Em dev, encaminha /api pro checador rodando localmente
    // (cd server && npm start).
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
