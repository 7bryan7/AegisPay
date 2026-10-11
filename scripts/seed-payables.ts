import { open } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import { loadApConfig } from "../apps/server/src/ap/config.js";
import { enrollPayables, validateEnrollment, EnrollmentConflict } from "../apps/server/src/obligations/enroll.js";
import { jsonLog, loadRootEnv } from "./shared.js";

try {
  const { values } = parseArgs({ options: { file: { type: "string" }, actor: { type: "string" }, check: { type: "boolean", default: false } } });
  if (!values.file || !values.actor) throw new Error("SEED_ARGUMENTS_REQUIRED");
  loadRootEnv();
  const config = loadApConfig();
  // Explicit local file only. Bounded read; never fetch a URL found in an invoice or manifest.
  const file = await open(values.file, "r");
  let raw: unknown;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1_000_000) throw new Error("INVALID_MANIFEST_FILE");
    const buffer = Buffer.alloc(1_000_001);
    let size = 0;
    while (size < buffer.length) {
      const result = await file.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > 1_000_000) throw new Error("INVALID_MANIFEST_FILE");
    raw = JSON.parse(buffer.subarray(0, size).toString("utf8")) as unknown;
  } finally { await file.close(); }
  const context = { businessId: config.BUSINESS_ID, actorId: values.actor, role: "OPERATOR" as const, paymentMode: config.PAYMENT_MODE };
  const manifest = validateEnrollment(context, raw);
  if (values.check) {
    jsonLog({ valid: true, databaseChecked: false, kind: manifest.kind, vendors: manifest.vendors.length,
      purchaseOrders: manifest.purchaseOrders.length, dispatchEnabled: false });
  } else {
    if (!config.DATABASE_URL) throw new Error("DATABASE_NOT_CONFIGURED");
    const pool = new Pool({ connectionString: config.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    try { jsonLog({ ...await enrollPayables(pool, context, manifest), dispatchEnabled: false }); }
    finally { await pool.end(); }
  }
} catch (error) {
  // Validation/driver errors can contain private manifest values or connection details.
  jsonLog({ ok: false, code: error instanceof EnrollmentConflict ? "ENROLLMENT_CONFLICT" : "ENROLLMENT_FAILED",
    message: "Check --file, --actor, business/mode, manifest fields and development database setup. Existing records are never overwritten." });
  process.exitCode = 1;
}
