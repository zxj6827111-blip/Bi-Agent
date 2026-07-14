import test from "node:test";
import assert from "node:assert/strict";
import { PumpStateMachine } from "../src/pumpRadar/pumpStateMachine.js";

test("PumpStateMachine enforces watch, paper-open and cooldown lifecycle", () => {
  let now = 1_000;
  const machine = new PumpStateMachine({ cooldownMs: 5_000, now: () => now });
  machine.startWatching("LABUSDT", { triggerPrice: 1 }, now);
  machine.confirm("LABUSDT", { score: 80 }, now + 1_000);
  machine.open("LABUSDT", "position-1", now + 1_500);
  machine.close("LABUSDT", "trailing_stop", now + 2_000);

  assert.equal(machine.get("LABUSDT").state, "cooldown");
  assert.equal(machine.canWatch("LABUSDT", now + 4_000), false);
  now += 7_001;
  assert.equal(machine.canWatch("LABUSDT"), true);
  machine.cleanup();
  assert.equal(machine.get("LABUSDT"), null);
});

test("PumpStateMachine rejects invalid lifecycle transitions", () => {
  const machine = new PumpStateMachine();
  machine.startWatching("BTCUSDT", {});
  assert.throws(() => machine.open("BTCUSDT", "position-1"), /Invalid pump state transition/);
});
