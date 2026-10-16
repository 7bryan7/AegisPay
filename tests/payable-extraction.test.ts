import { readFile } from "node:fs/promises";
import type { generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPayableExtractor } from "../apps/server/src/extraction/payable.js";
import { validateInvoiceImage } from "../apps/server/src/extraction/image.js";
import { syntheticPayable } from "./support/payable.js";

const config = { EXTRACTION_MODEL_API_KEY: "synthetic-key", EXTRACTION_MODEL_ID: "synthetic-model",
  EXTRACTION_MODEL_BASE_URL: "https://generativelanguage.googleapis.com/v1beta" };
const bytes = await readFile(new URL("../fixtures/synthetic-invoice.png", import.meta.url));
const image = validateInvoiceImage(bytes, "image/png", { maxBytes: 5_000_000, maxPixels: 20_000_000 });

describe("AP extraction boundary", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("sends a Gemini-compatible nested array schema through the actual SDK", async () => {
    const raw = syntheticPayable();
    const fetch = vi.fn((_input: unknown, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
      const request = JSON.parse(init.body) as { generationConfig: {
        responseSchema: { properties: { lineItems: { maxItems?: number } } }
      } };
      // The configured live model returned 400 when this nested bound was sent.
      expect(request.generationConfig.responseSchema.properties.lineItems.maxItems).toBeUndefined();
      return Promise.resolve(new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(raw) }] },
        finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }),
      { status: 200, headers: { "content-type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetch);
    await expect(createPayableExtractor(config).extract(image)).resolves.toEqual(raw);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("still rejects model output exceeding the canonical line-item limit", async () => {
    const raw = syntheticPayable();
    const field = { value: null, status: "MISSING" as const, sourceText: null };
    raw.lineItems = Array.from({ length: 201 }, () => ({ description: field, quantity: field, unitPrice: field, amount: field }));
    const generate = vi.fn(() => Promise.resolve({ output: raw })) as unknown as typeof generateText;
    await expect(createPayableExtractor(config, generate).extract(image)).rejects.toThrow();
  });
  it("preserves uncertainty and source facts through the structured output adapter", async () => {
    const raw = syntheticPayable();
    raw.dueDate = { value: "10/09/26", status: "AMBIGUOUS", sourceText: "10/09/26" };
    const generate = vi.fn(() => Promise.resolve({ output: raw })) as unknown as typeof generateText;
    await expect(createPayableExtractor(config, generate).extract(image)).resolves.toEqual(raw);
    const request = vi.mocked(generate).mock.calls[0]?.[0];
    expect(request?.tools).toBeUndefined();
    expect(request?.maxRetries).toBe(0);
    expect(request?.messages?.[0]).toMatchObject({ role: "user", content: [{ type: "file", mediaType: "image/png" }] });
  });
  it("rejects extra payment instructions and invented missing values", async () => {
    for (const raw of [{ ...syntheticPayable(), recipient: "attacker" },
      { ...syntheticPayable(), tax: { value: "0", status: "MISSING", sourceText: null } }]) {
      const generate = vi.fn(() => Promise.resolve({ output: raw })) as unknown as typeof generateText;
      await expect(createPayableExtractor(config, generate).extract(image)).rejects.toThrow();
    }
  });
  it("requires an explicitly configured model and rejects alternate endpoints before a call", () => {
    const generate = vi.fn() as unknown as typeof generateText;
    for (const change of [{ EXTRACTION_MODEL_ID: "" }, { EXTRACTION_MODEL_API_KEY: "" },
      { EXTRACTION_MODEL_BASE_URL: "https://example.invalid" }, { EXTRACTION_MODEL_ID: "../other" }]) {
      expect(() => createPayableExtractor({ ...config, ...change }, generate)).toThrow();
    }
    expect(generate).not.toHaveBeenCalled();
  });
});
