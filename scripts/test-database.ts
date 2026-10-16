import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { Client } from "pg";

// Always creates its own disposable database; never uses DATABASE_URL or a
// caller's AP_TEST_DATABASE_URL. Docker must be running and locally accessible.
if (process.argv.slice(2).some((arg) => arg !== "--browser")) throw new Error("Unknown test runner option");
const browser = process.argv.includes("--browser");
const name = `aegispay-tests-${randomUUID()}`;
const password = randomBytes(24).toString("hex");
let created = false;
let interrupted = false;
let runner: ChildProcess | undefined;
function interrupt() { interrupted = true; runner?.kill("SIGINT"); }
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  execFileSync("docker", ["run", "--rm", "--detach", "--name", name,
    "-e", "POSTGRES_USER=agentpay_test", "-e", `POSTGRES_PASSWORD=${password}`, "-e", "POSTGRES_DB=agentpay_test",
    "-p", "127.0.0.1::5432", "postgres:17"], { stdio: ["ignore", "pipe", "pipe"] });
  created = true;
  const binding = execFileSync("docker", ["port", name, "5432/tcp"], { encoding: "utf8" }).trim();
  if (!/^127\.0\.0\.1:\d+$/.test(binding)) throw new Error("Unexpected local database binding");
  const connectionString = `postgresql://agentpay_test:${password}@${binding}/agentpay_test`;
  const deadline = Date.now() + 45_000;
  let ready = false;
  while (Date.now() < deadline && !interrupted) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 1000 });
    try { await client.connect(); await client.query("SELECT 1"); ready = true; }
    catch { /* PostgreSQL is still initializing. */ }
    finally { await client.end().catch(() => undefined); }
    if (ready) break;
    await setTimeout(300);
  }
  if (interrupted || !ready || !process.env.npm_execpath) throw new Error("Test database or npm runner unavailable");
  runner = spawn(process.execPath, [process.env.npm_execpath, "run", browser ? "test:e2e:postgres" : "test:postgres"], {
    stdio: "inherit", env: { ...process.env, AP_TEST_DATABASE_URL: connectionString }
  });
  const code = await new Promise<number>((resolve) => {
    runner!.once("error", () => resolve(1));
    runner!.once("exit", (status) => resolve(status ?? 1));
  });
  process.exitCode = interrupted ? 130 : code;
} catch {
  console.error("Disposable database tests could not run. Check Docker access and availability of postgres:17. Existing databases were not used.");
  process.exitCode = interrupted ? 130 : 1;
} finally {
  if (created) {
    try { execFileSync("docker", ["stop", name], { stdio: "ignore" }); }
    catch { console.error(`Stop the temporary test container manually: docker stop ${name}`); process.exitCode = 1; }
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
