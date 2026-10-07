import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

const alias = {
  '@core': resolve('src/core'),
  '@shared': resolve('shared'),
};

export default defineConfig({
  main: { resolve: { alias } },
  preload: { resolve: { alias } },
  renderer: {
    resolve: { alias },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          // Скрытая страница сверки шейдера с эталоном для tests/e2e/shader-parity.spec.ts.
          parity: resolve('src/renderer/parity.html'),
        },
      },
    },
  },
});
