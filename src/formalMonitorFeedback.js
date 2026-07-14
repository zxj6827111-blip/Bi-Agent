import { clamp, round } from "./utils.js";

const FEEDBACK_RULES = {
  edge: { key: "minEdge", step: 2, min: 10, max: 40, tightenDirection: 1 },
  score: { key: "minScore", step: 3, min: 45, max: 80, tightenDirection: 1 },
  volume: { key: "minVolumeRatio", step: 0.1, min: 0.2, max: 2.5, tightenDirection: 1 },
  spread: { key: "maxFormalSpreadPercent", step: 0.01, min: 0.01, max: 1, tightenDirection: -1 }
};

export function buildFeedbackLoop(closedTrades = []) {
  const trades = closedTrades.filter((trade) => trade?.status === "closed" && !trade.isPartialClose);
  const basisKey = feedbackBasisKey(trades);
  if (trades.length < 3) {
    return { status: "insufficient_data", basisKey, totalTrades: trades.length, recommendations: [] };
  }

  const byFilterFailure = new Map();
  for (const trade of trades) {
    const failures = Array.isArray(trade.filterFailures) && trade.filterFailures.length
      ? trade.filterFailures
      : ["none"];
    for (const failure of failures) {
      const existing = byFilterFailure.get(failure) || { total: 0, wins: 0, netReturn: 0 };
      existing.total += 1;
      existing.wins += trade.netWin ? 1 : 0;
      existing.netReturn += Number(trade.estimatedNetReturnPercent || 0);
      byFilterFailure.set(failure, existing);
    }
  }

  const recommendations = [];
  for (const [failure, stats] of byFilterFailure) {
    if (stats.total < 3 || !FEEDBACK_RULES[failure]) continue;
    const winRate = stats.wins / stats.total;
    const avgReturn = stats.netReturn / stats.total;
    if (winRate < 0.25 && avgReturn < -0.5) {
      recommendations.push({
        filter: failure,
        winRate: round(winRate, 4),
        avgReturn: round(avgReturn, 4),
        sample: stats.total,
        action: "tighten",
        suggestion: `${failure} 过滤后的信号胜率仅 ${round(winRate * 100, 0)}%，建议提高对应阈值`
      });
    } else if (winRate > 0.6 && avgReturn > 0.5) {
      recommendations.push({
        filter: failure,
        winRate: round(winRate, 4),
        avgReturn: round(avgReturn, 4),
        sample: stats.total,
        action: "relax",
        suggestion: `${failure} 过滤后的信号胜率达 ${round(winRate * 100, 0)}%，可适当放宽阈值捕获更多信号`
      });
    }
  }

  return {
    status: "ok",
    basisKey,
    totalTrades: trades.length,
    filterDiagnostics: Object.fromEntries(byFilterFailure),
    recommendations
  };
}

export function applyFeedbackRecommendationsOnce(options, feedback, previousAdjustment = null) {
  if (!feedback || feedback.status !== "ok" || !feedback.recommendations?.length) {
    return { applied: false, options: { ...options }, adjustment: previousAdjustment };
  }
  if (previousAdjustment?.basisKey === feedback.basisKey) {
    return { applied: false, options: { ...options }, adjustment: previousAdjustment };
  }

  const nextOptions = { ...options };
  const appliedRecommendations = [];
  for (const recommendation of feedback.recommendations) {
    const rule = FEEDBACK_RULES[recommendation.filter];
    if (!rule || !["tighten", "relax"].includes(recommendation.action)) continue;
    const current = Number(nextOptions[rule.key]);
    if (!Number.isFinite(current)) continue;
    const actionDirection = recommendation.action === "tighten" ? 1 : -1;
    const delta = rule.step * rule.tightenDirection * actionDirection;
    nextOptions[rule.key] = round(clamp(current + delta, rule.min, rule.max), 4);
    appliedRecommendations.push(recommendation);
  }

  if (!appliedRecommendations.length) {
    return { applied: false, options: nextOptions, adjustment: previousAdjustment };
  }

  return {
    applied: true,
    options: nextOptions,
    adjustment: {
      basisKey: feedback.basisKey,
      lastApplied: new Date().toISOString(),
      recommendations: appliedRecommendations,
      currentOptions: Object.fromEntries(
        Object.values(FEEDBACK_RULES).map((rule) => [rule.key, nextOptions[rule.key]])
      )
    }
  };
}

function feedbackBasisKey(trades) {
  if (!trades.length) return "0:none";
  const latest = [...trades].sort((a, b) => {
    const timeDifference = Date.parse(a.closedAt || "") - Date.parse(b.closedAt || "");
    return timeDifference || String(a.id || "").localeCompare(String(b.id || ""));
  }).at(-1);
  return `${trades.length}:${latest?.id || "unknown"}:${latest?.closedAt || "unknown"}`;
}
