import { Pool } from 'pg';

const host = process.env.PGHOST;
const database = process.env.PGDATABASE;
const user = process.env.PGUSER;
const password = process.env.PGPASSWORD;
const port = Number(process.env.PGPORT ?? 5432);

if (!host || !database || !user || !password) {
  throw new Error('PostgreSQL connection environment variables are required');
}

export const pool = new Pool({
  host,
  port,
  database,
  user,
  password,
});
