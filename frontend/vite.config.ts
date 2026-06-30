import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 개발 중 /api 호출을 백엔드(8000)로 프록시.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET || "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
});
