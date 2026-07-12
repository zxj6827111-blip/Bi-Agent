import { config } from "./config.js";
import { summarizePerformance } from "./tradeMetrics.js";
import { round } from "./utils.js";

export function strategyGroupKey(item = {}) {
  return [
    item.marketType || "unknown_market",
    item.direction || item.side || "unknown_side",
    item.timeframe || item.interval || "unknown_timeframe",
    item.horizonHours ? `${item.horizonHours}h` : "live"
  ].join(":");
}

export function summarizeEvaluationSet(evaluations = [], {
  validation = config.validation
} = {}) {
  const completed = evaluations.filter((item) => item.status === "completed");
  const performance = summarizePerformance(completed);

  const byStrategyGroup = summarizeEvaluationGroups(completed, strategyGroupKey, { validation });
  const formalCandidates = Object.entries(byStrategyGroup)
    .filter(([, summary]) => summary.validation.status === "passed")
    .map(([key, summary]) => ({
      key,
      completedTrades: summary.total,
      netWinRate: summary.netWinRate,
      expectancyPercent: summary.expectancyPercent,
      profitFactor: summary.profitFactor,
      maxDrawdownPercent: summary.maxDrawdownPercent
    }))
    .sort((a, b) => (
      b.expectancyPercent - a.expectancyPercent
      || b.netWinRate - a.netWinRate
      || b.completedTrades - a.completedTrades
    ));

  return {
    total: evaluations.length,
    completed: completed.length,
    netWinRate: netWinRate(completed),
    targetWinRate: targetWinRate(completed),
    byDirection: summarizeEvaluationGroups(completed, (item) => item.direction, { validation }),
    byTimeframe: summarizeEvaluationGroups(completed, (item) => item.timeframe, { validation }),
    byHorizon: summarizeEvaluationGroups(completed, (item) => `${item.horizonHours}h`, { validation }),
    byStrategyGroup,
    formalCandidates,
    performance,
    validation: validationStatus(completed, performance, validation)
  };
}

export function summarizeEvaluationGroups(items = [], keyFn, {
  validation = config.validation
} = {}) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item) || "unknown";
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }

  return Object.fromEntries([...groups.entries()].map(([key, group]) => {
    const performance = summarizePerformance(group);
    return [
      key,
      {
        total: group.length,
        netWinRate: netWinRate(group),
        targetWinRate: targetWinRate(group),
        stops: group.filter((item) => item.outcome === "stop").length,
        noEntry: group.filter((item) => item.outcome === "no_entry").length,
        ...performance,
        validation: validationStatus(group, performance, validation)
      }
    ];
  }));
}

export function validationStatus(completed = [], performance = summarizePerformance(completed), validation = config.validation) {
  const wins = netWins(completed);
  const winRate = completed.length ? wins / completed.length : 0;
  const passed = completed.length >= validation.minCompletedTrades
    && winRate >= validation.minWinRate
    && performance.expectancyPercent >= validation.minExpectancyPercent
    && performance.maxDrawdownPercent <= validation.maxDrawdownPercent;

  return {
    status: passed ? "passed" : "insufficient_or_failed",
    completedTrades: completed.length,
    netWinRate: round(winRate, 4),
    minCompletedTrades: validation.minCompletedTrades,
    minWinRate: validation.minWinRate,
    expectancyPercent: performance.expectancyPercent,
    minExpectancyPercent: validation.minExpectancyPercent,
    maxDrawdownPercent: performance.maxDrawdownPercent,
    allowedMaxDrawdownPercent: validation.maxDrawdownPercent
  };
}

function netWinRate(items) {
  return items.length ? round(netWins(items) / items.length, 4) : 0;
}

function targetWinRate(items) {
  if (!items.length) return 0;
  const wins = items.filter((item) => item.outcome === "tp1" || item.outcome === "tp2").length;
  return round(wins / items.length, 4);
}

function netWins(items) {
  return items.filter((item) => Number(item.netResultPercent || item.estimatedNetReturnPercent || 0) > 0).length;
}
