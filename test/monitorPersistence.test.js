import test from "node:test";
import assert from "node:assert/strict";
import { nextSessionDayIso, sessionDateKey, sessionFileName } from "../src/monitorPersistence.js";

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
