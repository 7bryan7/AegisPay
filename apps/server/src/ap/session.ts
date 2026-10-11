import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { secretMatches } from "../auth/session.js";

export const apCookie = "agentpay_ap_session";
export const apSessionTtl = 7200;
const claimsSchema = z.strictObject({
  version: z.literal(1), sessionId: z.uuid(), businessId: z.string().min(1), actorId: z.string().min(1),
  role: z.enum(["OPERATOR", "REVIEWER"]), csrfToken: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int()
});
export type ApClaims = z.infer<typeof claimsSchema>;
function sign(payload: string, secret: string) { return createHmac("sha256", secret).update(payload).digest("base64url"); }
export function issueApSession(secret: string, businessId: string, role: ApClaims["role"], now = Date.now()) {
  if (secret.length < 32) throw new Error("SESSION_NOT_CONFIGURED");
  const claims: ApClaims = { version: 1, sessionId: randomUUID(), businessId, actorId: `${businessId}:${role.toLowerCase()}`,
    role, csrfToken: randomBytes(32).toString("hex"), expiresAt: now + apSessionTtl * 1000 };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return { claims, token: `${payload}.${sign(payload, secret)}` };
}
export function readApSession(cookie: string | undefined, secret: string, businessId: string, now = Date.now()): ApClaims | null {
  if (!cookie || secret.length < 32) return null;
  try {
    const entry = cookie.split(";").find((part) => part.trim().startsWith(`${apCookie}=`));
    const token = decodeURIComponent(entry?.trim().slice(apCookie.length + 1) ?? "");
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined || !secretMatches(signature, sign(payload, secret))) return null;
    const claims = claimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    return claims.businessId === businessId && claims.expiresAt > now ? claims : null;
  } catch { return null; }
}
