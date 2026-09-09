import { neon } from '@neondatabase/serverless'
import bcrypt from 'bcryptjs'
import 'dotenv/config'

const sql = neon(process.env.DATABASE_URL)
const hash = await bcrypt.hash('admin123', 10)

const result = await sql`
  INSERT INTO "User" (id, name, email, "passwordHash", role, "createdAt", "updatedAt")
  VALUES (gen_random_uuid(), ${'Admin'}, ${'admin@partyrock.local'}, ${hash}, ${'ADMIN'}::"Role", now(), now())
  ON CONFLICT (email) DO NOTHING
  RETURNING email, role
`

console.log('Seeded:', result)
