// app/api/auth/[...nextauth]/route.ts
// NextAuth v5 route handler — delegates to the configured providers and callbacks.

import { handlers } from '@/lib/auth'

export const { GET, POST } = handlers
