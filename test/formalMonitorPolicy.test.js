import test from "node:test";
import assert from "node:assert/strict";
import {
  applyFormalTradeGeometry,
  alignedOpenInterestChange,
  carryOpenTradeState,
  combineTradeRealizations,
  classifyFilteredSourceQuality,
  derivativesPeriodForInterval,
  executablePrice,
  hardExitOutcome,
  hourAdjustedOptions,
  hourBiasAt
} from "../src/formalMonitorPolicy.js";

test("hard exits take precedence for both long and short positions", () => {
  assert.equal(hardExitOutcome({ side: "long", takeProfit: 110, stopLoss: 90 }, 89), "stop");
  assert.equal(hardExitOutcome({ side: "long", takeProfit: 110, stopLoss: 90 }, 111), "tp");
  assert.equal(hardExitOutcome({ side: "short", takeProfit: 90, stopLoss: 110 }, 111), "stop");
  assert.equal(hardExitOutcome({ side: "short", takeProfit: 90, stopLoss: 110 }, 89), "tp");
  assert.equal(hardExitOutcome({ side: "long", takeProfit: null, stopLoss: 90 }, 100), null);
});

test("empty or invalid books never fabricate an executable price", () => {
  assert.equal(executablePrice({ bestBid: null, bestAsk: null }, "long", "close"), null);
  assert.equal(executablePrice({ bestBid: "NaN", bestAsk: 101 }, "long", "close"), null);
  assert.equal(executablePrice({ bestBid: 99, bestAsk: 101 }, "long", "close"), 99);
});

test("partial and final legs count as one weighted completed trade", () => {
  const combined = combineTradeRealizations([
    {
      id: "trade-1:partial",
      parentTradeId: "trade-1",
      isPartialClose: true,
      status: "closed",
      positionSizePercentOfEquity: 5,
      grossReturnPercent: 2,
      estimatedNetReturnPercent: 1.8,
      realizedAccountReturnPercent: 0.09
    },
    {
      id: "trade-1",
      status: "closed",
      outcome: "stop",
      positionSizePercentOfEquity: 5,
      grossReturnPercent: -1,
      estimatedNetReturnPercent: -1.2,
      realizedAccountReturnPercent: -0.06
    }
  ]);

  assert.equal(combined.length, 1);
  assert.equal(combined[0].realizationLegs, 2);
  assert.equal(combined[0].positionSizePercentOfEquity, 10);
  assert.equal(combined[0].estimatedNetReturnPercent, 0.3);
  assert.equal(combined[0].realizedAccountReturnPercent, 0.03);
  assert.equal(combined[0].netWin, true);
});

test("Shanghai session bias has explicit boundaries and halves low-liquidity exposure", () => {
  assert.equal(hourBiasAt(Date.parse("2026-07-13T16:00:00.000Z"), "Asia/Shanghai"), "low_liquidity");
  assert.equal(hourBiasAt(Date.parse("2026-07-13T23:59:59.000Z"), "Asia/Shanghai"), "low_liquidity");
  assert.equal(hourBiasAt(Date.parse("2026-07-14T00:00:00.000Z"), "Asia/Shanghai"), "normal");
  assert.equal(hourBiasAt(Date.parse("2026-07-14T05:00:00.000Z"), "Asia/Shanghai"), "high_volatility");

  const adjusted = hourAdjustedOptions({
    maxFormalSpreadPercent: 0.08,
    maxPositionSizePercentOfEquity: 35
  }, "low_liquidity");
  assert.equal(adjusted.maxFormalSpreadPercent, 0.04);
  assert.equal(adjusted.maxPositionSizePercentOfEquity, 17.5);

  const highVolatility = hourAdjustedOptions({
    confirmationScans: 2,
    executionMaxSoftFailures: 1,
    maxPositionSizePercentOfEquity: 40
  }, "high_volatility");
  assert.deepEqual(highVolatility, { maxPositionSizePercentOfEquity: 30 });
});

test("filtered source becomes a warning after independent entry quality passes", () => {
  const candidate = { sourceSignal: { qualityStatus: "filtered" } };
  assert.deepEqual(classifyFilteredSourceQuality(candidate, true), { failure: false, warning: true });
  assert.deepEqual(classifyFilteredSourceQuality(candidate, false), { failure: true, warning: false });
});

test("formal trade geometry is recalculated for each shadow profile", () => {
  const candidate = {
    symbol: "BTCUSDT",
    side: "long",
    entryPrice: 100,
    atrPercent: 2,
    roundTripCostPercent: 0.2,
    supportResistance: { support: 95 }
  };
  const control = applyFormalTradeGeometry(candidate, {
    minTargetPercent: 1,
    maxTargetPercent: 12,
    minStopPercent: 0.8,
    maxStopPercent: 5,
    targetAtrFraction: 2,
    stopAtrFraction: 1.2
  });
  const shadow = applyFormalTradeGeometry(candidate, {
    minTargetPercent: 1,
    maxTargetPercent: 12,
    minStopPercent: 0.8,
    maxStopPercent: 5,
    targetAtrFraction: 2.2,
    stopAtrFraction: 1
  });

  assert.equal(control.targetPercent, 4);
  assert.equal(control.stopPercent, 2.88);
  assert.equal(shadow.targetPercent, 4.4);
  assert.equal(shadow.stopPercent, 2.4);
  assert.ok(shadow.rewardRisk > control.rewardRisk);
});

test("derivatives requests use the execution period when Binance supports it", () => {
  assert.equal(derivativesPeriodForInterval("4h"), "4h");
  assert.equal(derivativesPeriodForInterval("1h"), "1h");
  assert.equal(derivativesPeriodForInterval("1m"), "5m");
});

test("OI changes are ignored when the derivatives window differs from execution", () => {
  assert.equal(alignedOpenInterestChange({ period: "5m", openInterestChangePercent: 2 }, "1m"), null);
  assert.equal(alignedOpenInterestChange({ period: "4h", openInterestChangePercent: 2 }, "4h"), 2);
});

test("daily rollover keeps partial legs that belong to carried positions", () => {
  const position = { id: "trade-1", status: "open" };
  const partial = { id: "trade-1:partial", parentTradeId: "trade-1", status: "closed", isPartialClose: true };
  const unrelated = { id: "trade-2:partial", parentTradeId: "trade-2", status: "closed", isPartialClose: true };
  const carried = carryOpenTradeState([position], [position, partial, unrelated], "2026-07-13");

  assert.equal(carried.positions.length, 1);
  assert.deepEqual(carried.trades.map((trade) => trade.id), ["trade-1", "trade-1:partial"]);
  assert.ok(carried.trades.every((trade) => trade.carriedFromSession === "2026-07-13"));
});
