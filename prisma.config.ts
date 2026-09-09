import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    // DATABASE_URL is required for migrate/db push; optional for generate
    url: process.env.DATABASE_URL ?? 'postgresql://localhost/placeholder',
  },
})
