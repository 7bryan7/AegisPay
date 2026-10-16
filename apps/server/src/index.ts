import { createApApp } from "./ap/app.js";
import { loadApConfig } from "./ap/config.js";
import { createApStore } from "./ap/store.js";
import { createPool } from "./persistence/database.js";

const config = loadApConfig();
const pool = config.DATABASE_URL ? createPool(config.DATABASE_URL) : null;
const app = createApApp(config, pool ? createApStore(pool, config.INPUT_RETENTION_HOURS,
  { maxBytes: config.MAX_INPUT_BYTES, maxPixels: config.MAX_INPUT_PIXELS }) : null);

const server = app.listen(config.PORT, () => {
  console.log(JSON.stringify({ event: "server_started", port: config.PORT, network: "Arc Testnet", mode: config.PAYMENT_MODE,
    workerStatusPath: "/ready" }));
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  server.close(() => { void pool?.end(); });
});

