import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";
import { createApApp } from "../../apps/server/src/ap/app.js";
import { createApStore } from "../../apps/server/src/ap/store.js";
import { enrollPayables } from "../../apps/server/src/obligations/enroll.js";
import { syntheticEnrollment } from "../support/enrollment.js";
import { fixtureConfig } from "../support/ap-fixture.js";

const connectionString = process.env.AP_TEST_DATABASE_URL;
if (!connectionString || connectionString === process.env.DATABASE_URL) throw new Error("DISPOSABLE_TEST_DATABASE_REQUIRED");
const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
for (const name of (await readdir(new URL("../../migrations/", import.meta.url))).filter((file) => /^\d+.*\.sql$/.test(file)).sort())
  await pool.query(await readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
const manifest = syntheticEnrollment(fixtureConfig.BUSINESS_ID);
manifest.treasury.policy.autoPayMaxMicroUsdc = "1000000";
await enrollPayables(pool, { businessId: fixtureConfig.BUSINESS_ID, actorId: "synthetic-owner", role: "OPERATOR", paymentMode: "fixture" }, manifest);
const server = createApApp({ ...fixtureConfig, PORT: 4300, WEB_ORIGIN: "http://127.0.0.1:3300" }, createApStore(pool, 168)).listen(4300, "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => server.close(() => { void pool.end(); }));
