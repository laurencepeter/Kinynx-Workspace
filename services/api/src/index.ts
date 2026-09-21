import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { closePool } from "./db/pool.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // Apply migrations on boot so `docker compose up` is enough to be usable.
  await runMigrations();

  const app = await buildApp(config);
  await app.listen({ host: "0.0.0.0", port: config.API_PORT });

  const shutdown = async (signal: string) => {
    app.log.info(`received ${signal}, shutting down`);
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
