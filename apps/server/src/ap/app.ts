import express, { type Request, type RequestHandler } from "express";
import cors from "cors";
import multer from "multer";
import { z } from "zod";
import { apSessionSchema, auditSchema, invoiceDetailSchema, invoiceListSchema, treasuryViewSchema, uploadResultSchema } from "@agentpay/core";
import { secretMatches } from "../auth/session.js";
import { errorHandler, HttpError, notFound } from "../http/errors.js";
import { createRateLimit } from "../http/rate-limit.js";
import { validateInvoiceImage } from "../extraction/image.js";
import { IngestionConflict } from "../obligations/ingest.js";
import type { ApConfig } from "./config.js";
import { apCookie, apSessionTtl, issueApSession, readApSession, type ApClaims } from "./session.js";
import { ApprovalConflict, type ApStore } from "./store.js";
import { createArcReconciliationFromEnvironment } from "../payments/reconcile.js";

export function createApApp(config: ApConfig, store: ApStore | null = null) {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: config.WEB_ORIGIN, credentials: true }));
  app.use(express.json({ limit: "16kb" }));
  app.use((_request, response, next) => { response.set("Cache-Control", "no-store"); response.set("X-Content-Type-Options", "nosniff"); next(); });
  const cookieOptions = { httpOnly: true, secure: config.NODE_ENV === "production", sameSite: "lax" as const, path: "/" };
  const loginAvailable = config.SESSION_SECRET.length >= 32 && Boolean(config.DEMO_ACCESS_CODE || config.REVIEWER_ACCESS_CODE);
  function claims(request: Request): ApClaims {
    const session = readApSession(request.header("cookie"), config.SESSION_SECRET, config.BUSINESS_ID);
    if (!session) throw new HttpError("UNAUTHENTICATED", "Sign in to view invoices", 401);
    return session;
  }
  const trustedOrigin: RequestHandler = (request, _response, next) => {
    if (request.header("origin") !== config.WEB_ORIGIN) throw new HttpError("INVALID_ORIGIN", "Request origin is not allowed", 403);
    next();
  };
  const operator: RequestHandler = (request, _response, next) => {
    if (claims(request).role !== "OPERATOR") throw new HttpError("OPERATOR_REQUIRED", "Operator access is required", 403);
    next();
  };
  const csrf: RequestHandler = (request, _response, next) => {
    if (!secretMatches(request.header("x-csrf-token") ?? "", claims(request).csrfToken)) throw new HttpError("INVALID_CSRF", "Request verification failed", 403);
    next();
  };
  const loginLimit = createRateLimit({ max: 10, windowMs: 60_000, key: (request) => request.ip ?? "unknown" });
  const sessionLimit = createRateLimit({ max: 60, windowMs: 60_000, key: (request) => claims(request).sessionId });
  async function database<T>(businessId: string, work: (db: ApStore) => Promise<T>): Promise<T> {
    if (!store) throw new HttpError("DATABASE_UNAVAILABLE", "Database is not configured. Add development credentials to enable invoices.", 503, true);
    try {
      if (!await store.ready(businessId)) throw new HttpError("TREASURY_NOT_CONFIGURED", "Set up the business treasury before uploading invoices", 503);
      return await work(store);
    } catch (error) {
      if (error instanceof HttpError || error instanceof IngestionConflict || error instanceof ApprovalConflict) throw error;
      throw new HttpError("DATABASE_UNAVAILABLE", "Invoice storage is unavailable. Check database setup and migrations.", 503, true);
    }
  }
  app.get("/health", (_request, response) => response.json({ status: "ok", network: "Arc Testnet", dispatchEnabled: false }));
  app.get("/ready", async (_request, response) => {
    let storage = false;
    try { storage = store !== null && await store.ready(config.BUSINESS_ID); } catch { /* report no details */ }
    let workers: Awaited<ReturnType<ApStore["workerStatus"]>>=null;
    try {if(storage) workers=await store!.workerStatus(config.BUSINESS_ID);} catch { /* Missing/stale heartbeat is unavailable. */ }
    const ready=loginAvailable && storage && workers?.extractionAvailable===true && workers.paymentAvailable;
    response.status(ready?200:503).json({ status: ready?"ready":"unavailable", authentication: loginAvailable, storage,
      extractionWorker: workers?.extractionAvailable??false, paymentWorker: workers?.paymentAvailable??false, dispatchEnabled: workers?.dispatchEnabled??false });
  });
  app.get("/api/session", (request, response) => {
    const session = readApSession(request.header("cookie"), config.SESSION_SECRET, config.BUSINESS_ID);
    response.json(apSessionSchema.parse(session ? { authenticated: true, role: session.role, csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString() } : { authenticated: false, loginAvailable }));
  });
  app.post("/api/session", trustedOrigin, loginLimit, (request, response) => {
    if (!loginAvailable) throw new HttpError("AUTH_NOT_CONFIGURED", "Set up session and access credentials before signing in", 503);
    const { code } = z.strictObject({ code: z.string().min(1).max(256) }).parse(request.body);
    const role = config.DEMO_ACCESS_CODE && secretMatches(code, config.DEMO_ACCESS_CODE) ? "OPERATOR"
      : config.REVIEWER_ACCESS_CODE && secretMatches(code, config.REVIEWER_ACCESS_CODE) ? "REVIEWER" : null;
    if (!role) throw new HttpError("INVALID_ACCESS_CODE", "Access code is incorrect", 401);
    const session = issueApSession(config.SESSION_SECRET, config.BUSINESS_ID, role);
    response.cookie(apCookie, session.token, { ...cookieOptions, maxAge: apSessionTtl * 1000 });
    response.status(201).json(apSessionSchema.parse({ authenticated: true, role, csrfToken: session.claims.csrfToken,
      expiresAt: new Date(session.claims.expiresAt).toISOString() }));
  });
  app.delete("/api/session", trustedOrigin, csrf, (_request, response) => { response.clearCookie(apCookie, cookieOptions); response.status(204).end(); });
  app.get("/api/invoices", sessionLimit, async (request, response) => {
    const session = claims(request);
    // Reviewers never query the private business store. Sanitized fixtures will be added separately.
    if (session.role === "REVIEWER") { response.json({ invoices: [], nextOffset: null }); return; }
    const offset = z.coerce.number().int().min(0).max(10000).parse(request.query.offset ?? 0);
    response.json(invoiceListSchema.parse(await database(session.businessId, (db) => db.list(session.businessId, offset))));
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5_000_000, files: 1, fields: 1, fieldSize: 500 } });
  app.post("/api/invoices", trustedOrigin, operator, csrf, sessionLimit, upload.single("invoice"), async (request, response) => {
    const session = claims(request);
    const key = z.string().trim().min(1).max(200).parse(request.header("idempotency-key"));
    const fields = z.strictObject({ purchaseOrderHint: z.string().trim().min(1).max(500).optional() }).parse(request.body);
    if (!request.file) throw new HttpError("INVALID_IMAGE", "Choose one PNG or JPEG invoice", 400);
    validateInvoiceImage(request.file.buffer, request.file.mimetype, { maxBytes: 5_000_000, maxPixels: 20_000_000 });
    const file = request.file;
    try {
      const result = await database(session.businessId, (db) => db.upload(session, key, fields.purchaseOrderHint ?? null, file.buffer, file.mimetype));
      response.status(result.reused ? 200 : 202).json(uploadResultSchema.parse(result));
    } catch (error) {
      if (error instanceof IngestionConflict) {
        throw new HttpError(error.code, error.code === "DUPLICATE_INPUT"
          ? `This image is already saved as invoice ${error.obligationId}. Open it from the inbox.`
          : "This upload key already belongs to different input. Select the intended file again.", 409);
      }
      throw error;
    }
  });
  app.get("/api/invoices/:id", sessionLimit, operator, async (request, response) => {
    const session = claims(request), id = z.uuid().parse(request.params.id);
    const result = await database(session.businessId, (db) => db.detail(session.businessId, id));
    if (!result) throw new HttpError("NOT_FOUND", "Invoice not found", 404);
    response.json(invoiceDetailSchema.parse(result));
  });
  app.get("/api/invoices/:id/audit", sessionLimit, operator, async (request, response) => {
    const session = claims(request), id = z.uuid().parse(request.params.id);
    const result = await database(session.businessId, (db) => db.audit(session.businessId, id));
    if (!result) throw new HttpError("NOT_FOUND", "Invoice not found", 404);
    response.json(auditSchema.parse(result));
  });
  app.get("/api/invoices/:id/image", sessionLimit, operator, async (request, response) => {
    const session = claims(request), id = z.uuid().parse(request.params.id);
    const result = await database(session.businessId, (db) => db.image(session.businessId, id));
    if (!result) throw new HttpError("NOT_FOUND", "Source image is unavailable or has expired", 404);
    response.type(result.mimeType).set("Content-Disposition", "inline").send(result.bytes);
  });
  app.post("/api/invoices/:id/approve", trustedOrigin, operator, csrf, sessionLimit, async (request, response) => {
    const session = claims(request), id = z.uuid().parse(request.params.id);
    const input = z.strictObject({ decisionId: z.uuid(), reason: z.string().trim().min(1).max(2000) }).parse(request.body);
    let result: { approvalId: string; expiresAt: string };
    try {
      result = await database(session.businessId, (db) => db.approve(session.businessId, session.actorId, id, input.decisionId, input.reason));
    } catch (error) {
      if (error instanceof ApprovalConflict) throw new HttpError(error.code, "The decision is no longer eligible for approval", 409);
      throw error;
    }
    response.status(201).json(result);
  });
  app.post("/api/treasury/pause", trustedOrigin, operator, csrf, sessionLimit, async (request, response) => {
    const session=claims(request), input=z.strictObject({paused:z.boolean()}).parse(request.body);
    await database(session.businessId,db=>db.setPaused(session.businessId,session.actorId,input.paused));
    response.status(204).end();
  });
  app.get("/api/treasury", sessionLimit, async (request, response) => {
    const session = claims(request);
    const stored = session.role === "OPERATOR" ? await database(session.businessId, (db) => db.treasury(session.businessId)) : null;
    let cashMicroUsdc: string | null=null;
    if (config.PAYMENT_MODE==="arc_testnet" && stored?.walletAddress && stored.walletAddress===process.env.ARC_WALLET_ADDRESS) {
      try { cashMicroUsdc=(await createArcReconciliationFromEnvironment(process.env)?.cashReader.read())?.cashMicroUsdc??null; }
      catch { /* An unavailable RPC never produces a fabricated balance. */ }
    }
    let workers: Awaited<ReturnType<ApStore["workerStatus"]>>=null;
    if (stored) {try {workers=await store!.workerStatus(session.businessId);} catch { /* Fail closed. */ }}
    const dispatchEnabled=config.PAYMENT_MODE==="arc_testnet" && workers?.dispatchEnabled===true && stored?.paused===false;
    response.json(treasuryViewSchema.parse({ network: "Arc Testnet", configuredMode: config.PAYMENT_MODE,
      dispatchEnabled, screening: "local_registry", walletAddress: stored?.walletAddress ?? null,
      paused: stored?.paused ?? true, cashMicroUsdc, holdsMicroUsdc: stored?.holdsMicroUsdc ?? null,
      minimumReserveMicroUsdc: stored?.minimumReserveMicroUsdc ?? null,
      message: session.role === "REVIEWER" ? "Reviewer access is isolated from private treasury data. No sanitized examples are available yet."
        : `${cashMicroUsdc===null?"Live balance unavailable.":"Balance read from Arc Testnet."} ${workers?"Recent worker heartbeat received.":"Worker heartbeat missing or stale."} ${dispatchEnabled?"Dispatch is configured; every payment still requires fresh checks.":"New payment submissions are disabled."}` }));
  });
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
