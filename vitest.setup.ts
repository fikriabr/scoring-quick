// vitest.setup.ts
//
// `next/server`'s `after()` only works inside a real Next.js request scope —
// calling it from a route handler invoked directly in a unit test (with no
// surrounding server) throws "`after` was called outside a request scope".
// Route handlers use `after()` purely to keep a serverless invocation alive
// long enough for a fire-and-forget background task to finish; that concern
// doesn't exist in tests, so here it just runs the task immediately, matching
// the plain fire-and-forget behavior the existing route tests assert on.
import { vi } from 'vitest'

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return {
    ...actual,
    after: (task: () => unknown) => {
      task()
    },
  }
})
