import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite + React config. The `test` block configures Vitest.
// Our unit tests only cover PURE logic modules (geometry + state machines),
// so a plain Node environment is all we need: no jsdom, no browser, no webcam.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The pose-detection library statically imports @mediapipe/pose for its
      // BlazePose model. That package is an un-bundleable UMD file and we never
      // use BlazePose (we use MoveNet), so point it at a harmless local stub so
      // the production build can complete. See src/stubs/mediapipe-pose.js.
      '@mediapipe/pose': fileURLToPath(
        new URL('./src/stubs/mediapipe-pose.js', import.meta.url)
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.js'],
  },
});
