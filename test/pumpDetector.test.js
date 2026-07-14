import test from "node:test";
import assert from "node:assert/strict";
import { PumpDetector } from "../src/pumpRadar/pumpDetector.js";
import { RollingPriceWindow } from "../src/pumpRadar/rollingWindow.js";

test("PumpDetector discovers a liquid 10-second acceleration and confirms executable flow", () => {
  const detector = new PumpDetector({ minQuoteVolume: 1_000_000, minConfirmScore: 70 });
  const history = new RollingPriceWindow();
  history.add(0, 100);
  history.add(5_000, 100.4);
  history.add(10_000, 101.8);

  const discovery = detector.evaluateDiscovery({
    symbol: "LABUSDT",
    history,
    quoteVolume: 20_000_000,
    now: 10_000
  });
  assert.equal(discovery.detected, true);
  assert.equal(discovery.triggerWindowMs, 10_000);

  const confirmation = detector.evaluateConfirmation({
    discovery,
    currentPrice: 102.4,
    book: { eventTime: 15_000, bidPrice: 102.39, bidQty: 200, askPrice: 102.4, askQty: 180 },
    depth: { imbalance: 0.2 },
    trades: { totalQuote: 80_000, buyRatio: 0.68 },
    crossVenue: { availableCount: 2, confirmedCount: 1 },
    now: 15_000
  });

  assert.equal(confirmation.status, "confirmed");
  assert.ok(confirmation.score >= 70);
  assert.deepEqual(confirmation.failures, []);
});

test("PumpDetector rejects an overextended entry instead of chasing the top", () => {
  const detector = new PumpDetector({ maxEntryChasePercent: 1 });
  const confirmation = detector.evaluateConfirmation({
    discovery: { detectedAt: 0, triggerPrice: 100, discoveryScore: 50 },
    currentPrice: 102,
    book: { eventTime: 5_000, bidPrice: 101.9, bidQty: 200, askPrice: 102, askQty: 200 },
    depth: { imbalance: 0.1 },
    trades: { totalQuote: 100_000, buyRatio: 0.7 },
    crossVenue: { availableCount: 1, confirmedCount: 1 },
    now: 5_000
  });

  assert.equal(confirmation.status, "rejected");
  assert.ok(confirmation.failures.includes("entry_too_late"));
});
