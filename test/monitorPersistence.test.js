import test from "node:test";
import assert from "node:assert/strict";
import { sessionDateKey, sessionFileName } from "../src/monitorPersistence.js";

test("monitor daily sessions use the Asia/Shanghai natural-day boundary", () => {
  assert.equal(sessionDateKey(new Date("2026-07-12T15:59:59.000Z")), "2026-07-12");
  assert.equal(sessionDateKey(new Date("2026-07-12T16:00:00.000Z")), "2026-07-13");
  assert.equal(sessionFileName("2026-07-13"), "session-2026-07-13.json");
});
