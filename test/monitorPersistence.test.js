import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCompactMonitorSnapshot,
  nextSessionDayIso,
  sessionDateKey,
  sessionFileName
} from "../src/monitorPersistence.js";

test("monitor daily sessions use the Asia/Shanghai natural-day boundary", () => {
  assert.equal(sessionDateKey(new Date("2026-07-12T15:59:59.000Z")), "2026-07-12");
  assert.equal(sessionDateKey(new Date("2026-07-12T16:00:00.000Z")), "2026-07-13");
  assert.equal(sessionFileName("2026-07-13"), "session-2026-07-13.json");
});

test("daily risk pause resumes at the next Shanghai session boundary", () => {
  assert.equal(
    nextSessionDayIso(Date.parse("2026-07-14T03:00:00.000Z"), "Asia/Shanghai"),
    "2026-07-14T16:00:00.000Z"
  );
});

test("compact checkpoints remove aggregate histories and closed-trade polls", () => {
  const snapshot = buildCompactMonitorSnapshot({
    persistenceVersion: 1,
    diagnostics: { aggregate: { evaluated: 10 } },
    opportunityHistory: { scalpAlerts: [{ symbol: "BTCUSDT" }] },
    positions: [{ id: "open-1", status: "open", polls: [{ price: 100 }] }],
    trades: [
      { id: "open-1", status: "open", polls: [{ price: 100 }] },
      { id: "closed-1", status: "closed", polls: [{ price: 90 }] }
    ]
  });

  assert.equal(snapshot.persistenceVersion, 2);
  assert.equal("diagnostics" in snapshot, false);
  assert.equal("opportunityHistory" in snapshot, false);
  assert.equal(snapshot.positions[0].polls.length, 1);
  assert.equal("polls" in snapshot.trades[0], false);
  assert.equal("polls" in snapshot.trades[1], false);
});
