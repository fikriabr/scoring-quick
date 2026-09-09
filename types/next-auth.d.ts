// types/next-auth.d.ts
// Module augmentation to extend NextAuth v5 Session and JWT types with
// the custom `role` and `id` fields injected by lib/auth/config.ts.

import type { Role } from '@prisma/client'
import type { DefaultSession } from 'next-auth'

declare module 'next-auth' {
  /**
   * Extends the built-in Session.user type with `id` and `role`.
   * These fields are populated by the `session` callback in lib/auth/config.ts.
   */
  interface Session {
    user: {
      id: string
      role: Role
    } & DefaultSession['user']
  }

  /**
   * Extends the built-in User type returned from the `authorize` callback.
   * Allows TypeScript to recognise `role` on the user object inside the `jwt` callback.
   */
  interface User {
    role: Role
  }
}

declare module '@auth/core/jwt' {
  /**
   * Extends the built-in JWT type with `id` and `role`.
   * These fields are set in the `jwt` callback in lib/auth/config.ts.
   */
  interface JWT {
    id: string
    role: Role
  }
}
