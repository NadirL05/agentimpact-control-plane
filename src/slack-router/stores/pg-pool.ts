import { Pool, type PoolClient } from 'pg';

let pool: Pool | null = null;

export function getSlackRouterPool(): Pool {
  if (pool) return pool;

  const host = process.env.PGHOST;
  const database = process.env.PGDATABASE;
  const user = process.env.PGUSER;
  const password = process.env.PGPASSWORD;
  const port = Number(process.env.PGPORT ?? 5432);

  if (!host || !database || !user || !password) {
    throw new Error('missing_postgres_env');
  }

  pool = new Pool({ host, port, database, user, password, max: 5 });
  return pool;
}

export type PgQueryable = Pick<PoolClient, 'query'>;
