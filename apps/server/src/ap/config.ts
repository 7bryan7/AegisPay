import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { z } from "zod";

config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });
const blank = z.string().default("");
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.url().default("http://localhost:3000"),
  BUSINESS_ID: z.string().trim().min(1).default("local-business"),
  DATABASE_URL: blank.refine((value) => value === "" || /^postgres(?:ql)?:\/\//.test(value)),
  SESSION_SECRET: blank.refine((value) => value === "" || value.length >= 32),
  DEMO_ACCESS_CODE: blank.refine((value) => value === "" || value.length >= 12),
  REVIEWER_ACCESS_CODE: blank.refine((value) => value === "" || value.length >= 12),
  PAYMENT_MODE: z.enum(["disabled", "fixture", "arc_testnet"]).default("disabled"),
  INPUT_RETENTION_HOURS: z.coerce.number().int().min(1).max(8760).default(168)
}).refine((value) => !value.REVIEWER_ACCESS_CODE || value.REVIEWER_ACCESS_CODE !== value.DEMO_ACCESS_CODE,
  "Operator and reviewer access codes must differ");
export type ApConfig = z.infer<typeof schema>;
export function loadApConfig(environment: NodeJS.ProcessEnv = process.env): ApConfig { return schema.parse(environment); }
