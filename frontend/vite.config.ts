import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Load env from both current directory (frontend/) and parent directory
  const envFrontend = loadEnv(mode, __dirname, '');
  const envParent = loadEnv(mode, rootDir, '');
  const googleClientId =
    envFrontend.VITE_GOOGLE_CLIENT_ID ||
    envParent.VITE_GOOGLE_CLIENT_ID ||
    envParent.GOOGLE_CLIENT_ID ||
    '';

  return {
    envDir: __dirname,
    plugins: [
      react(),
      tailwindcss(),
    ],
    define: {
      'import.meta.env.VITE_GOOGLE_CLIENT_ID': JSON.stringify(googleClientId),
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:3001',
          changeOrigin: true,
          secure: false,
        },
        '/admin': {
          target: 'http://127.0.0.1:3001',
          changeOrigin: true,
          secure: false,
        },
      },
    },
  };
});
