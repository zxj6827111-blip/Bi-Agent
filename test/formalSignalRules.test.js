import test from "node:test";
import assert from "node:assert/strict";
import { allowsRiskOffShortEntry, buildFormalSafetyFailures, updateSignalConfirmations } from "../src/formalSignalRules.js";

test("missing ADX data is not treated as a weak trend", () => {
  const failures = buildFormalSafetyFailures({ adx: null, volumeRatio: 0.8 }, {});
  assert.ok(!failures.includes("low_trend_strength"));
});

test("risk-off short entry path is reachable with aligned technical evidence", () => {
  assert.equal(allowsRiskOffShortEntry({
    side: "short",
    marketRegime: { bias: "risk_off" },
    trend: "down",
    technicalAligned: true,
    edgeAligned: 20
  }, { executionMinEdge: 18 }), true);
  assert.equal(allowsRiskOffShortEntry({
    side: "short",
    marketRegime: { bias: "risk_on" },
    trend: "down",
    technicalAligned: true,
    edgeAligned: 20
  }, { executionMinEdge: 18 }), false);
});

test("buildFormalSafetyFailures blocks chase, high volatility, and wide spread", () => {
  const failures = buildFormalSafetyFailures({
    side: "long",
    priceChangePercent24h: 28.4,
    atrPercent: 2.24,
    spreadPercent: 0.11
  }, {
    maxChase24hPercent: 18,
    maxAtrPercent: 2,
    maxSpreadPercent: 0.08
  });

  assert.deepEqual(failures, ["chase24h", "volatility", "spread"]);
});

test("buildFormalSafetyFailures blocks short chasing after large selloff", () => {
  const failures = buildFormalSafetyFailures({
    side: "short",
    priceChangePercent24h: -22,
    atrPercent: 1.2,
    spreadPercent: 0.02
  }, {
    maxChase24hPercent: 18,
    maxAtrPercent: 2,
    maxSpreadPercent: 0.08
  });

  assert.deepEqual(failures, ["chase24h"]);
});

test("buildFormalSafetyFailures supports stricter long chase limits", () => {
  const failures = buildFormalSafetyFailures({
    side: "long",
    priceChangePercent24h: 13,
    atrPercent: 1.1,
    spreadPercent: 0.02
  }, {
    maxChase24hPercent: 18,
    maxLongChase24hPercent: 12,
    maxShortChase24hPercent: 18,
    maxAtrPercent: 2,
    maxSpreadPercent: 0.08
  });

  assert.deepEqual(failures, ["chase24h"]);
});

test("buildFormalSafetyFailures blocks weak net target and reward risk", () => {
  const failures = buildFormalSafetyFailures({
    side: "long",
    priceChangePercent24h: 4,
    atrPercent: 1.1,
    spreadPercent: 0.02,
    targetPercent: 0.3,
    stopPercent: 0.35,
    roundTripCostPercent: 0.2
  }, {
    maxLongChase24hPercent: 12,
    maxAtrPercent: 2,
    maxSpreadPercent: 0.08,
    minNetTargetPercent: 0.15,
    minRewardRisk: 1.15
  });

  assert.deepEqual(failures, ["net_target", "reward_risk"]);
});

test("buildFormalSafetyFailures allows boundary-equal net target despite floating point noise", () => {
  const failures = buildFormalSafetyFailures({
    side: "short",
    priceChangePercent24h: 0.3,
    atrPercent: 0.12,
    spreadPercent: 0.01,
    targetPercent: 0.35,
    stopPercent: 0.25,
    roundTripCostPercent: 0.2
  }, {
    maxShortChase24hPercent: 18,
    maxAtrPercent: 2,
    maxSpreadPercent: 0.08,
    minNetTargetPercent: 0.15,
    minRewardRisk: 1.15
  });

  assert.deepEqual(failures, []);
});

test("updateSignalConfirmations requires consecutive scans", () => {
  const first = updateSignalConfirmations({}, [
    { symbol: "BTCUSDT", side: "long" }
  ], {
    scanCount: 1,
    requiredScans: 2,
    nowIso: "2026-07-06T00:00:00.000Z"
  });

  assert.equal(first.readyCandidates.length, 0);
  assert.equal(first.pendingCandidates[0].confirmation.count, 1);

  const second = updateSignalConfirmations(first.confirmations, [
    { symbol: "BTCUSDT", side: "long" }
  ], {
    scanCount: 2,
    requiredScans: 2,
    nowIso: "2026-07-06T00:03:00.000Z"
  });

  assert.equal(second.readyCandidates.length, 1);
  assert.equal(second.readyCandidates[0].confirmation.count, 2);
});

test("updateSignalConfirmations resets after a missed scan", () => {
  const first = updateSignalConfirmations({}, [
    { symbol: "BTCUSDT", side: "long" }
  ], {
    scanCount: 1,
    requiredScans: 2,
    nowIso: "2026-07-06T00:00:00.000Z"
  });
  const gap = updateSignalConfirmations(first.confirmations, [], {
    scanCount: 2,
    requiredScans: 2,
    nowIso: "2026-07-06T00:03:00.000Z"
  });
  const third = updateSignalConfirmations(gap.confirmations, [
    { symbol: "BTCUSDT", side: "long" }
  ], {
    scanCount: 3,
    requiredScans: 2,
    nowIso: "2026-07-06T00:06:00.000Z"
  });

  assert.equal(third.readyCandidates.length, 0);
  assert.equal(third.pendingCandidates[0].confirmation.count, 1);
});

test("updateSignalConfirmations can confirm repeated signals inside a recent window", () => {
  const first = updateSignalConfirmations({}, [
    { symbol: "BTCUSDT", side: "long" }
  ], {
    scanCount: 1,
    requiredScans: 2,
    staleScans: 3,
    consecutiveOnly: false,
    nowIso: "2026-07-06T00:00:00.000Z"
  });
  const gap = updateSignalConfirmations(first.confirmations, [], {
    scanCount: 2,
    requiredScans: 2,
    staleScans: 3,
    consecutiveOnly: false,
    nowIso: "2026-07-06T00:03:00.000Z"
  });
  const third = updateSignalConfirmations(gap.confirmations, [
    { symbol: "BTCUSDT", side: "long" }
  ], {
    scanCount: 3,
    requiredScans: 2,
    staleScans: 3,
    consecutiveOnly: false,
    nowIso: "2026-07-06T00:06:00.000Z"
  });

  assert.equal(third.readyCandidates.length, 1);
  assert.equal(third.readyCandidates[0].confirmation.count, 2);
  assert.equal(third.readyCandidates[0].confirmation.consecutiveOnly, false);
});
