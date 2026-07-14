import test from "node:test";
import assert from "node:assert/strict";
import {
  activeRiskGuard,
  buildPositionRiskPlan,
  calculatePortfolioRiskMetrics,
  portfolioEntryBlockers,
  realizedAccountReturnPercent
} from "../src/portfolioRisk.js";

test("realizedAccountReturnPercent converts price return into account risk return", () => {
  assert.equal(realizedAccountReturnPercent({
    estimatedNetReturnPercent: 3,
    stopPercent: 2,
    accountRiskPercent: 0.5
  }), 0.75);
});

test("buildPositionRiskPlan caps notional size for tight stops", () => {
  assert.deepEqual(buildPositionRiskPlan({ stopPercent: 0.24 }, {
    accountRiskPerTradePercent: 0.5,
    maxPositionSizePercentOfEquity: 35
  }), {
    targetAccountRiskPercent: 0.5,
    accountRiskPercent: 0.084,
    positionSizePercentOfEquity: 35,
    sizeCapped: true
  });
});

test("calculatePortfolioRiskMetrics measures peak-to-trough account drawdown", () => {
  const trades = [
    closedTrade("2026-07-11T01:00:00.000Z", 2),
    closedTrade("2026-07-11T02:00:00.000Z", -3),
    closedTrade("2026-07-11T03:00:00.000Z", 0.5)
  ];
  const metrics = calculatePortfolioRiskMetrics(trades, { nowMs: Date.parse("2026-07-11T04:00:00.000Z") });

  assert.equal(metrics.totalAccountReturnPercent, -0.5);
  assert.equal(metrics.peakAccountReturnPercent, 2);
  assert.equal(metrics.maxDrawdownPercent, 3);
  assert.equal(metrics.currentDrawdownPercent, 2.5);
  assert.equal(metrics.dailyAccountReturnPercent, -0.5);
});

test("daily portfolio risk follows the configured monitor timezone", () => {
  const trades = [
    closedTrade("2026-07-13T15:59:59.000Z", -1),
    closedTrade("2026-07-13T16:00:00.000Z", -2)
  ];
  const metrics = calculatePortfolioRiskMetrics(trades, {
    nowMs: Date.parse("2026-07-13T17:00:00.000Z"),
    timeZone: "Asia/Shanghai"
  });

  assert.equal(metrics.dailyAccountReturnPercent, -2);
});

test("portfolioEntryBlockers limits same-side concentration and total open risk", () => {
  const positions = [
    { side: "long", accountRiskPercent: 0.5, positionSizePercentOfEquity: 30 },
    { side: "long", accountRiskPercent: 0.5, positionSizePercentOfEquity: 30 },
    { side: "short", accountRiskPercent: 0.5, positionSizePercentOfEquity: 30 }
  ];
  const blockers = portfolioEntryBlockers({
    positions,
    candidate: { side: "long" },
    candidateRiskPlan: { accountRiskPercent: 0.5, positionSizePercentOfEquity: 20 },
    accountRiskPerTradePercent: 0.5,
    maxPortfolioRiskPercent: 1.5,
    maxSameSideOpen: 2,
    maxPortfolioPositionSizePercentOfEquity: 100
  });

  assert.deepEqual(blockers, ["same_side_limit", "portfolio_risk_limit", "portfolio_position_size_limit"]);
});

test("activeRiskGuard keeps a session drawdown halt active without a fake resume time", () => {
  assert.deepEqual(activeRiskGuard({ sessionHaltedAt: "2026-07-11T02:00:00.000Z" }), {
    reason: "session_max_drawdown",
    resumeAt: null
  });
});

function closedTrade(closedAt, realizedAccountReturnPercentValue) {
  return {
    status: "closed",
    closedAt,
    realizedAccountReturnPercent: realizedAccountReturnPercentValue
  };
}
