import { PumpRadarMonitor } from "../src/pumpRadar/pumpRadarMonitor.js";

const monitor = new PumpRadarMonitor();
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM", "SIGQUIT"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    monitor.stop(`signal_${signal.toLowerCase()}`).catch((error) => {
      console.error(`[pump-radar] shutdown failed: ${error.message}`);
      process.exitCode = 1;
    });
  });
}

try {
  await monitor.start();
  await monitor.wait();
} catch (error) {
  console.error(`[pump-radar] fatal: ${error.stack || error.message}`);
  await monitor.stop("fatal_error").catch(() => {});
  process.exitCode = 1;
}
