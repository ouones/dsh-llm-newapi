import { defineConfig } from 'vitest/config'

// Resolve workspace-style package imports (`@deepseek-ai/dsh-*`) to their
// built lib through node_modules; no repo-local path mapping exists here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
})
