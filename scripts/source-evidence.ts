import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

// Offline source evidence only. Never reads .env, upload storage, databases or
// provider credentials. Hashes identify this dirty checkout independently of HEAD.
const root = resolve(import.meta.dirname, ".."), entries: { path: string; sha256: string }[] = [];
async function collect(path: string) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || ["node_modules", "dist", "test-results"].includes(entry.name)) continue;
    const file = join(path, entry.name);
    if (entry.isDirectory()) await collect(file);
    else if (entry.isFile()) entries.push({ path: relative(root, file), sha256: createHash("sha256").update(await readFile(file)).digest("hex") });
  }
}
for (const dir of ["apps/server/src", "apps/web/app", "apps/web/lib", "packages/core/src", "migrations", "scripts", "tests", "fixtures"])
  await collect(join(root, dir));
for (const file of ["package.json", "package-lock.json", "apps/server/package.json", "apps/web/package.json", "packages/core/package.json",
  "tsconfig.json", "tsconfig.base.json", "tsconfig.scripts.json", "apps/server/tsconfig.json", "apps/server/tsconfig.build.json",
  "apps/web/tsconfig.json", "packages/core/tsconfig.json", "packages/core/tsconfig.build.json", "apps/web/next.config.ts", "playwright.config.ts", "playwright.postgres.config.ts", "vitest.config.ts", "vitest.postgres.config.ts", "render.yaml"])
  entries.push({ path: file, sha256: createHash("sha256").update(await readFile(join(root, file))).digest("hex") });
entries.sort((a, b) => a.path.localeCompare(b.path));
let baseCommit: string | null = null;
try { baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { /* Source hashes remain usable. */ }
const fingerprint = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
const directory = join(root, "docs", "evidence"); await mkdir(directory, { recursive: true });
await writeFile(join(directory, "source-manifest.json"), JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version,
  baseCommit, sourceFingerprint: fingerprint, scope: "AP source/config/tests/fixtures; excludes secrets, generated builds and private runtime data", files: entries }, null, 2) + "\n");
console.log(`Source evidence saved: docs/evidence/source-manifest.json (${fingerprint})`);
