import test from "node:test";
import assert from "node:assert/strict";
import { applyFeedbackRecommendationsOnce, buildFeedbackLoop } from "../src/formalMonitorFeedback.js";

test("feedback is pure and applies the same completed-trade sample only once", () => {
  const trades = makeTrades("edge", -1);
  const originalFailures = trades.map((trade) => [...trade.filterFailures]);
  const feedback = buildFeedbackLoop(trades);
  const first = applyFeedbackRecommendationsOnce(baseOptions(), feedback);
  const second = applyFeedbackRecommendationsOnce(first.options, feedback, first.adjustment);

  assert.equal(first.applied, true);
  assert.equal(first.options.minEdge, 27);
  assert.equal(second.applied, false);
  assert.equal(second.options.minEdge, 27);
  assert.deepEqual(trades.map((trade) => trade.filterFailures), originalFailures);
});

test("feedback adjustments are finite and monotonic for volume and spread", () => {
  const volumeTighten = applyFeedbackRecommendationsOnce(baseOptions(), buildFeedbackLoop(makeTrades("volume", -1)));
  const spreadTighten = applyFeedbackRecommendationsOnce(baseOptions(), buildFeedbackLoop(makeTrades("spread", -1)));
  const volumeRelax = applyFeedbackRecommendationsOnce(baseOptions(), buildFeedbackLoop(makeTrades("volume", 1)));
  const spreadRelax = applyFeedbackRecommendationsOnce(baseOptions(), buildFeedbackLoop(makeTrades("spread", 1)));

  assert.ok(volumeTighten.options.minVolumeRatio > baseOptions().minVolumeRatio);
  assert.ok(spreadTighten.options.maxFormalSpreadPercent < baseOptions().maxFormalSpreadPercent);
  assert.ok(volumeRelax.options.minVolumeRatio < baseOptions().minVolumeRatio);
  assert.ok(spreadRelax.options.maxFormalSpreadPercent > baseOptions().maxFormalSpreadPercent);
  assert.ok([
    volumeTighten.options.minVolumeRatio,
    spreadTighten.options.maxFormalSpreadPercent,
    volumeRelax.options.minVolumeRatio,
    spreadRelax.options.maxFormalSpreadPercent
  ].every(Number.isFinite));
});

function baseOptions() {
  return { minEdge: 25, minScore: 72, minVolumeRatio: 0.45, maxFormalSpreadPercent: 0.08 };
}

function makeTrades(filter, netReturn) {
  return Array.from({ length: 3 }, (_, index) => ({
    id: `trade-${index}`,
    status: "closed",
    closedAt: `2026-07-13T00:0${index}:00.000Z`,
    filterFailures: [filter],
    estimatedNetReturnPercent: netReturn,
    netWin: netReturn > 0
  }));
}
