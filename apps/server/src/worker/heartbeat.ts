/** Keep liveness independent of extraction/model latency. Serialize writes so a
 * late healthy pulse cannot overwrite shutdown or a processing failure. */
export function startWorkerHeartbeat(write: (healthy: boolean) => Promise<void>, intervalMs = 15_000) {
  let healthy = true;
  let stopped = false;
  let pending = Promise.resolve();
  function pulse() {
    const status = healthy;
    pending = pending.then(() => write(status)).catch(() => undefined);
    return pending;
  }
  const timer = setInterval(() => { if (!stopped) void pulse(); }, intervalMs);
  timer.unref();
  return {
    setHealthy(value: boolean) {
      if (stopped) return pending;
      healthy = value;
      return pulse();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      healthy = false;
      await pulse();
    }
  };
}
