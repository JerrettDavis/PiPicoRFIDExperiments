import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/PiPicoRFIDExperiments/' : '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
}));
