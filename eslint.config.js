// eslint.config.js
// ESLint 9 flat config. Loaded as ESM via `"type": "module"` in package.json.
//
// Replaces the legacy .eslintrc.json: Next.js 16 removed the `next lint`
// command, so linting runs through the eslint CLI directly, which defaults to
// flat config. eslint-config-next v16 exports flat config arrays.

import coreWebVitals from 'eslint-config-next/core-web-vitals'
import typescript from 'eslint-config-next/typescript'

const config = [
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'],
  },
  ...coreWebVitals,
  ...typescript,
]

export default config
