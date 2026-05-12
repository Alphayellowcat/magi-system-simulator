import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { harnessBridgePlugin } from './server/harnessBridge';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: parseInt(env.VITE_PORT || '3000'),
        host: '0.0.0.0',
      },
      plugins: [react(), harnessBridgePlugin(__dirname)],
      define: {
        'process.env.OPENAI_API_KEY': JSON.stringify(env.OPENAI_API_KEY),
        'process.env.OPENAI_BASE_URL': JSON.stringify(env.OPENAI_BASE_URL),
        'process.env.OPENAI_MODEL_NAME': JSON.stringify(env.OPENAI_MODEL_NAME)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
