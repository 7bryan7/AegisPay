import { z } from "zod";

export const MICRO_USDC_PER_USDC = 1_000_000n;
export const MAX_MICRO_USDC = 99_999_999_999_999_999_999n;

/** Canonical JSON/NUMERIC(20,0) representation; independent of legacy tinybars. */
export const microUsdcStringSchema = z.string().regex(/^(0|[1-9]\d{0,19})$/);

export function parseMicroUsdc(value: string): bigint {
  return BigInt(microUsdcStringSchema.parse(value));
}

export function formatMicroUsdc(value: bigint): string {
  return microUsdcStringSchema.parse(value.toString());
}

/** Reject rounding, exponents, signs, separators and unsupported precision. */
export function usdcToMicroUsdc(value: string): bigint {
  if (!/^(0|[1-9]\d{0,13})(\.\d{1,6})?$/.test(value)) {
    throw new RangeError("USDC must be an unsigned decimal with at most six decimal places");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return parseMicroUsdc((BigInt(whole) * MICRO_USDC_PER_USDC + BigInt(fraction.padEnd(6, "0"))).toString());
}

export function microUsdcToUsdc(value: bigint): string {
  formatMicroUsdc(value);
  return `${value / MICRO_USDC_PER_USDC}.${(value % MICRO_USDC_PER_USDC).toString().padStart(6, "0")}`;
}

/** Arc native USDC has 18 decimals; reserve even a fractional micro-USDC. */
export function nativeUsdcToMicroUsdcCeil(value: bigint): bigint {
  if (value < 0n) throw new RangeError("native amount cannot be negative");
  const scale = 1_000_000_000_000n;
  return parseMicroUsdc(((value + scale - 1n) / scale).toString());
}

export const tinybarStringSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, "must be an unsigned base-10 integer")
  .refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER), {
    message: "amount exceeds the supported safe integer boundary"
  });

export function parseTinybars(value: string): bigint {
  return BigInt(tinybarStringSchema.parse(value));
}

export function formatTinybars(value: bigint): string {
  if (value < 0n) {
    throw new RangeError("tinybar amount cannot be negative");
  }
  return value.toString(10);
}

export function isWithinBudget(amount: bigint, remainingBudget: bigint): boolean {
  return amount >= 0n && amount <= remainingBudget;
}

