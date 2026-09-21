import pg from "pg";

export type DB = pg.Pool;

let pool: pg.Pool | null = null;

export function getPool(connectionString?: string): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: connectionString ?? process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

/** Convenience typed query helper. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  db: pg.Pool,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await db.query<T>(text, params as never[]);
  return res.rows;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
