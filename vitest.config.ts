import { defineConfig } from 'vitest/config';
import { alias } from './vite.shared.ts';

export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
  },
});
