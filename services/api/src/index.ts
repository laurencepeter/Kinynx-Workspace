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
  if (process.env.NODE_ENV === "production" && /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(config.PUBLIC_APP_URL)) {
    app.log.warn(
      `PUBLIC_APP_URL is ${config.PUBLIC_APP_URL}: emailed invite/sign-in/reset links and published-page URLs will point at localhost. Set it to your public origin, e.g. https://kinynx.example.com`,
    );
  }

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
