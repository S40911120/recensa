import { defineConfig } from 'vitest/config';

// Unit-test config kept separate from vite.config.ts so the production build config stays untouched.
// Default env is happy-dom (lighter) for the pure-logic tests. md.test.ts overrides to jsdom via a
// per-file docblock: DOMPurify 3.4.x needs a spec-faithful DOM, which happy-dom 20.x doesn't provide
// (it silently drops elements), so only jsdom exercises the sanitization boundary the way the browser does.
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
});
