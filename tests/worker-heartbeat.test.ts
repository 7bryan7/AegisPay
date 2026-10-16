import { afterEach, expect, it, vi } from "vitest";
import { startWorkerHeartbeat } from "../apps/server/src/worker/heartbeat.js";

afterEach(() => { vi.useRealTimers(); });

it("keeps a slow batch alive, preserves failure status and stops with an unhealthy pulse", async () => {
  vi.useFakeTimers();
  const write = vi.fn<(_: boolean) => Promise<void>>().mockResolvedValue(undefined);
  const heartbeat = startWorkerHeartbeat(write);
  await heartbeat.setHealthy(true);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(write).toHaveBeenCalledTimes(9);
  expect(write.mock.calls.every(([healthy]) => healthy)).toBe(true);
  await heartbeat.setHealthy(false);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(write.mock.calls.slice(-3).every(([healthy]) => !healthy)).toBe(true);
  await heartbeat.setHealthy(true);
  await heartbeat.stop();
  expect(write).toHaveBeenLastCalledWith(false);
  const count = write.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(write).toHaveBeenCalledTimes(count);
});

it("serializes a delayed write before shutdown and tolerates storage failure", async () => {
  vi.useFakeTimers();
  let finish: () => void = () => undefined;
  const slow = new Promise<void>((resolve) => { finish = resolve; });
  const write = vi.fn<(_: boolean) => Promise<void>>()
    .mockImplementationOnce(() => slow).mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(undefined);
  const heartbeat = startWorkerHeartbeat(write);
  const started = heartbeat.setHealthy(true);
  await Promise.resolve();
  const stopping = heartbeat.stop();
  expect(write).toHaveBeenCalledTimes(1);
  finish();
  await Promise.all([started, stopping]);
  expect(write.mock.calls).toEqual([[true], [false]]);
});
