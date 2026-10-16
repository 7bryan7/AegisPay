import { describe, expect, it } from "vitest";
import { loadApConfig } from "../apps/server/src/ap/config.js";

describe("AP runtime limits", () => {
  it("accepts bounded poll/upload settings and refuses invalid or unsafe overrides", () => {
    expect(loadApConfig({ WORKER_POLL_MS: "2000", MAX_INPUT_BYTES: "1000", MAX_INPUT_PIXELS: "2000" }))
      .toMatchObject({ WORKER_POLL_MS: 2000, MAX_INPUT_BYTES: 1000, MAX_INPUT_PIXELS: 2000 });
    for (const values of [{ WORKER_POLL_MS: "0" }, { WORKER_POLL_MS: "60001" }, { MAX_INPUT_BYTES: "5000001" },
      { MAX_INPUT_PIXELS: "20000001" }, { MAX_INPUT_BYTES: "NaN" }]) expect(() => loadApConfig(values)).toThrow();
  });
});
