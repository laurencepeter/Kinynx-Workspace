/**
 * Kinynx background worker (services/worker, folded into the API image with a
 * separate entrypoint). Runs scheduled maintenance: token/invite cleanup and
 * retention-policy application. Same code, same migrations — just `node
 * dist/worker.js` instead of the API.
 */
import { loadConfig } from "./config.js";
import { getPool, closePool } from "./db/pool.js";
import { applyRetentionAll, cleanupExpired } from "./jobs/index.js";

const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 15 * 60 * 1000); // 15 min default

async function tick(): Promise<void> {
  const db = getPool();
  try {
    const cleaned = await cleanupExpired(db);
    const retention = await applyRetentionAll(db);
    console.log(`[worker] cleanup=${JSON.stringify(cleaned)} retention=${JSON.stringify(retention)}`);
  } catch (err) {
    console.error(`[worker] tick failed: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  getPool(config.DATABASE_URL);
  console.log(`[worker] started; interval=${INTERVAL_MS}ms`);
  await tick();
  const timer = setInterval(() => void tick(), INTERVAL_MS);

  const shutdown = async () => {
    clearInterval(timer);
    await closePool();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
