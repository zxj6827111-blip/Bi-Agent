import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PumpRadarEventStore } from "../src/pumpRadar/eventStore.js";

test("PumpRadarEventStore writes partitioned NDJSON and a lightweight atomic snapshot", async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), "bi-agent-radar-test-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const store = new PumpRadarEventStore({ outputDir, now: () => Date.parse("2026-07-14T10:00:00.000Z") });
  await store.initialize();
  await store.append("pump_detected", { symbol: "LABUSDT" });
  await store.writeSnapshot({ status: "running", updatedAt: "2026-07-14T10:00:00.000Z", health: {}, positions: [] });
  await store.flush();

  const event = JSON.parse((await readFile(join(outputDir, "events-2026-07-14.ndjson"), "utf8")).trim());
  const latest = JSON.parse(await readFile(join(outputDir, "latest.json"), "utf8"));
  assert.equal(event.symbol, "LABUSDT");
  assert.equal(latest.status, "running");
});
