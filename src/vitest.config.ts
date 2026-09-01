import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'api/**/*.test.ts',
      'core/**/*.test.ts',
      'middleware/**/*.test.ts',
    ],
    exclude: [
      'node_modules',
      'dist',
      'src/**/*.test.ts'
    ]
  }
});
