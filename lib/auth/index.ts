// lib/auth/index.ts
// Re-exports the single NextAuth v5 instance from config.ts.
// This avoids creating multiple NextAuth instances which can cause
// inconsistent session/token behavior.

export { handlers, auth, signIn, signOut } from './config'
