import test from "node:test";
import assert from "node:assert/strict";
import { applyWatchLifecycle, lifecycleEventsToAlerts } from "../src/watchLifecycle.js";

test("watch lifecycle suppresses reverse signal before the active long is closed", () => {
  const first = applyWatchLifecycle({
    current: makeCurrent({
      price: 100,
      alert: makeAlert({
        direction: "long",
        action: "合约开多",
        entryRange: [99, 101],
        stopLoss: 95,
        takeProfit: { tp1: 105, tp2: 110 }
      })
    }),
    now: 1_000
  });

  assert.equal(first.position.status, "open");
  assert.equal(first.current.alert.direction, "long");
  assert.equal(lifecycleEventsToAlerts(first.current, first.events).length, 1);

  const second = applyWatchLifecycle({
    current: makeCurrent({
      price: 101,
      alert: makeAlert({
        direction: "short",
        action: "合约开空",
        entryRange: [100, 102],
        stopLoss: 106,
        takeProfit: { tp1: 96, tp2: 92 }
      })
    }),
    position: first.position,
    now: 2_000
  });

  assert.equal(second.position.status, "open");
  assert.equal(second.current.alert.direction, "long");
  assert.equal(second.current.alert.lifecycleStatus, "holding");
  assert.ok(second.events.some((event) => event.type === "suppress_reverse"));
  assert.equal(lifecycleEventsToAlerts(second.current, second.events).length, 0);
});

test("watch lifecycle closes a long at TP before allowing a new direction", () => {
  const opened = applyWatchLifecycle({
    current: makeCurrent({
      price: 100,
      alert: makeAlert({
        direction: "long",
        entryRange: [99, 101],
        stopLoss: 95,
        takeProfit: { tp1: 105, tp2: 110 }
      })
    }),
    now: 1_000,
    reverseCooldownMs: 500
  });

  const closed = applyWatchLifecycle({
    current: makeCurrent({
      price: 105,
      alert: makeAlert({
        direction: "short",
        entryRange: [104, 106],
        stopLoss: 110,
        takeProfit: { tp1: 100, tp2: 96 }
      })
    }),
    position: opened.position,
    now: 2_000,
    reverseCooldownMs: 500
  });

  assert.equal(closed.position.status, "closed");
  assert.equal(closed.position.closeReason, "tp1");
  assert.equal(closed.current.alert.direction, "wait");
  assert.equal(lifecycleEventsToAlerts(closed.current, closed.events).length, 1);

  const next = applyWatchLifecycle({
    current: makeCurrent({
      price: 104,
      alert: makeAlert({
        direction: "short",
        action: "合约开空",
        entryRange: [103, 105],
        stopLoss: 108,
        takeProfit: { tp1: 99, tp2: 95 }
      })
    }),
    position: closed.position,
    now: 3_000,
    reverseCooldownMs: 500
  });

  assert.equal(next.position.status, "open");
  assert.equal(next.current.alert.direction, "short");
});

test("watch lifecycle closes a long when a strong reverse exit signal appears", () => {
  const opened = applyWatchLifecycle({
    current: makeCurrent({
      price: 100,
      alert: makeAlert({
        direction: "long",
        entryRange: [99, 101],
        stopLoss: 95,
        takeProfit: { tp1: 120, tp2: 130 }
      })
    }),
    now: 1_000,
    reverseCooldownMs: 500
  });

  const closed = applyWatchLifecycle({
    current: makeCurrent({
      price: 99,
      alert: makeAlert({
        direction: "long",
        entryRange: [98, 100],
        stopLoss: 95,
        takeProfit: { tp1: 120, tp2: 130 }
      }),
      exitSignals: [
        makeExitSignal({
          direction: "short",
          score: 78,
          timeframe: "5m"
        })
      ]
    }),
    position: opened.position,
    now: 2_000,
    reverseCooldownMs: 500
  });

  assert.equal(closed.position.status, "closed");
  assert.equal(closed.position.closeReason, "reverse_signal");
  assert.equal(closed.current.alert.direction, "wait");
  assert.equal(lifecycleEventsToAlerts(closed.current, closed.events).length, 1);

  const next = applyWatchLifecycle({
    current: makeCurrent({
      price: 98,
      alert: makeAlert({
        direction: "short",
        action: "合约开空",
        entryRange: [97, 99],
        stopLoss: 103,
        takeProfit: { tp1: 92, tp2: 88 }
      })
    }),
    position: closed.position,
    now: 3_000,
    reverseCooldownMs: 500
  });

  assert.equal(next.position.status, "open");
  assert.equal(next.current.alert.direction, "short");
});

function makeCurrent({ price, alert, exitSignals = [] }) {
  return {
    symbol: "XLMUSDT",
    price,
    alert,
    exitSignals
  };
}

function makeAlert(overrides) {
  return {
    score: 80,
    timeframe: "15m",
    riskReward: 1.5,
    riskNotes: [],
    ...overrides
  };
}

function makeExitSignal(overrides) {
  return {
    score: 70,
    timeframe: "1m",
    riskReward: 0.5,
    entryRange: [98, 100],
    stopLoss: 103,
    takeProfit: { tp1: 95, tp2: 92 },
    ...overrides
  };
}
