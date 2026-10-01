import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    // Supabase: use the direct connection (port 5432) or session pooler for drizzle-kit,
    // the app itself connects through the transaction pooler (6543).
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres",
  },
});
