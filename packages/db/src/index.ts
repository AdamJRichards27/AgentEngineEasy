import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index.js";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. AgentEngineEasy uses its own database — " +
      "do not point this at AgentEngineStaging's database. See .env.example.",
  );
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const db = drizzle(pool, { schema });
export * from "./schema/index.js";
