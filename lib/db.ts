// lib/db.ts
// Prisma client singleton with Neon HTTP adapter (Prisma 6.x).
// PrismaNeonHTTP connects via HTTPS fetch instead of WebSocket, which is
// more reliable in restricted network environments (avoids WebSocket
// connection failures seen with the PrismaNeon pool adapter).

import { PrismaClient } from '@prisma/client'
import { PrismaNeonHTTP } from '@prisma/adapter-neon'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaNeonHTTP(process.env.DATABASE_URL!, {})
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })
}

export const db = globalForPrisma.prisma ?? createPrismaClient()
export const prisma = db

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = db
}
