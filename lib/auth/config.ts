// lib/auth/config.ts
// NextAuth v5 (Auth.js) configuration with CredentialsProvider.
// Validates email/password via Zod, compares bcrypt hash, injects role and id
// into JWT token and session callbacks.

import NextAuth from 'next-auth'
import type { NextAuthConfig } from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import type { Role } from '@prisma/client'

// ---------------------------------------------------------------------------
// Zod schema for login credentials
// Zod v4 uses `error` (not `required_error`) for type-level errors, and
// `message` for refinement errors.
// ---------------------------------------------------------------------------

const LoginSchema = z.object({
  email: z
    .string()
    .min(1, { message: 'Email is required.' })
    .email({ message: 'Invalid email format.' }),
  password: z
    .string()
    .min(1, { message: 'Password cannot be empty.' }),
})

// ---------------------------------------------------------------------------
// NextAuth configuration
// ---------------------------------------------------------------------------

export const authConfig: NextAuthConfig = {
  providers: [
    Credentials({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        // 1. Validate shape and types via Zod
        const parsed = LoginSchema.safeParse(credentials)
        if (!parsed.success) {
          // Return null to indicate authentication failure
          return null
        }

        const { email, password } = parsed.data

        // 2. Look up user by email
        const user = await prisma.user.findUnique({
          where: { email },
          select: {
            id: true,
            name: true,
            email: true,
            passwordHash: true,
            role: true,
          },
        })

        if (!user) {
          return null
        }

        // 3. Compare provided password against stored bcrypt hash
        const passwordMatch = await bcrypt.compare(password, user.passwordHash)
        if (!passwordMatch) {
          return null
        }

        // 4. Return the user object — fields are forwarded to the jwt callback.
        //    We include `role` as a custom field; TypeScript knows about it via
        //    the `User` interface augmentation in types/next-auth.d.ts.
        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        }
      },
    }),
  ],

  // Derive the application URL from the incoming request instead of a
  // hardcoded AUTH_URL. Without this, Auth.js falls back to AUTH_URL for the
  // post-login redirect, so signing in on a Vercel domain would bounce the
  // browser to http://localhost:3000/admin. Vercel terminates TLS in front of
  // the app and forwards the real host, which Auth.js reads from
  // x-forwarded-host / x-forwarded-proto.
  trustHost: true,

  session: {
    strategy: 'jwt',
  },

  callbacks: {
    /**
     * Called when a JWT is created (sign-in) or updated (session access).
     * We persist `id` and `role` from the User object into the token so that
     * the session callback can surface them to the client without a DB round-trip.
     */
    jwt({ token, user }) {
      if (user) {
        // `user` is only present on the initial sign-in trigger.
        // user.id can be undefined in the base NextAuth User type, but
        // our authorize() always returns a user with an id string.
        if (user.id) token.id = user.id
        token.role = (user as { id: string; role: Role }).role
      }
      return token
    },

    /**
     * Called whenever a session is checked.
     * Copies `id` and `role` from the encrypted JWT into the session object
     * so that client components and server-side code can read them.
     */
    session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string
        session.user.role = token.role as Role
      }
      return session
    },
  },

  pages: {
    signIn: '/login',
  },
}

// ---------------------------------------------------------------------------
// NextAuth v5 instance
// Exports `auth` (server-side session getter), `handlers` (GET/POST route
// handlers), and `signIn`/`signOut` helpers.
// ---------------------------------------------------------------------------

export const { auth, handlers, signIn, signOut } = NextAuth(authConfig)
