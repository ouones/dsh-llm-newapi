import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js'],
  outDir: 'lib',
  format: ['esm'],
  clean: false,
  dts: false,
  sourcemap: false,
  outExtensions: () => ({ js: '.js' }),
})
