import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite + React config. The `test` block configures Vitest.
// Our unit tests only cover PURE logic modules (geometry + state machines),
// so a plain Node environment is all we need: no jsdom, no browser, no webcam.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.js'],
  },
});
