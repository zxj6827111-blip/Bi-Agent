import { realizedAccountReturnPercent } from "./portfolioRisk.js";
import { clamp, round } from "./utils.js";

const BINANCE_DERIVATIVES_PERIODS = new Set(["5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"]);

export function hardExitOutcome(position, exitPrice) {
  if (exitPrice == null || position?.takeProfit == null || position?.stopLoss == null) return null;
  const price = Number(exitPrice);
  const takeProfit = Number(position?.takeProfit);
  const stopLoss = Number(position?.stopLoss);
  if (![price, takeProfit, stopLoss].every((value) => Number.isFinite(value) && value > 0)) return null;

  if (position.side === "long") {
    if (price >= takeProfit) return "tp";
    if (price <= stopLoss) return stopExitOutcome(position);
  } else if (position.side === "short") {
    if (price <= takeProfit) return "tp";
    if (price >= stopLoss) return stopExitOutcome(position);
  }
  return null;
}

function stopExitOutcome(position) {
  if (position?.trailingStopActive) return "trailing_stop";
  if (position?.breakevenStopApplied) return "breakeven_stop";
  return "stop";
}

export function alignedOpenInterestChange(derivatives, executionInterval) {
  if (!derivatives || derivatives.period !== executionInterval) return null;
  const value = Number(derivatives.openInterestChangePercent);
  return Number.isFinite(value) ? value : null;
}

export function executablePrice(book, side, action) {
  const raw = side === "long"
    ? action === "open" ? book?.bestAsk : book?.bestBid
    : action === "open" ? book?.bestBid : book?.bestAsk;
  const price = Number(raw);
  return Number.isFinite(price) && price > 0 ? price : null;
}

export function carryOpenTradeState(positions = [], trades = [], previousSessionDate = null) {
  const carriedPositions = positions.map((position) => ({
    ...position,
    carriedOver: true,
    carriedFromSession: previousSessionDate
  }));
  const openIds = new Set(carriedPositions.map((position) => position.id));
  const carriedPartialLegs = trades
    .filter((trade) => trade?.isPartialClose && openIds.has(trade.parentTradeId))
    .map((trade) => ({
      ...trade,
      carriedOver: true,
      carriedFromSession: previousSessionDate
    }));
  return { positions: carriedPositions, trades: [...carriedPositions, ...carriedPartialLegs] };
}

export function combineTradeRealizations(closedLegs = []) {
  const partialsByParent = new Map();
  for (const leg of closedLegs.filter((trade) => trade?.isPartialClose && trade.parentTradeId)) {
    const legs = partialsByParent.get(leg.parentTradeId) || [];
    legs.push(leg);
    partialsByParent.set(leg.parentTradeId, legs);
  }

  return closedLegs.filter((trade) => !trade?.isPartialClose).map((trade) => {
    const legs = [...(partialsByParent.get(trade.id) || []), trade];
    if (legs.length === 1) return trade;
    const totalSize = legs.reduce((sum, leg) => sum + Number(leg.positionSizePercentOfEquity || 0), 0);
    const weighted = (field) => totalSize > 0
      ? legs.reduce((sum, leg) => sum + Number(leg[field] || 0) * Number(leg.positionSizePercentOfEquity || 0), 0) / totalSize
      : Number(trade[field] || 0);
    const weightedNet = weighted("estimatedNetReturnPercent");
    return {
      ...trade,
      positionSizePercentOfEquity: round(totalSize, 4),
      grossReturnPercent: round(weighted("grossReturnPercent"), 4),
      estimatedNetReturnPercent: round(weightedNet, 4),
      netReturnPercent: round(weightedNet, 4),
      realizedAccountReturnPercent: round(legs.reduce((sum, leg) => sum + realizedAccountReturnPercent(leg), 0), 4),
      netWin: weightedNet > 0,
      realizationLegs: legs.length
    };
  });
}

export function hourBiasAt(nowMs = Date.now(), timeZone = "Asia/Shanghai") {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23"
  }).format(new Date(nowMs)));
  if (hour >= 13 && hour <= 21) return "high_volatility";
  if (hour >= 0 && hour <= 7) return "low_liquidity";
  return "normal";
}

export function hourAdjustedOptions(options, bias) {
  if (bias === "high_volatility") {
    return {
      // 时段只影响仓位；方向确认和候选质量由真实 ATR、价差及多周期数据决定。
      maxPositionSizePercentOfEquity: Number(options.maxPositionSizePercentOfEquity) * 0.75
    };
  }
  if (bias === "low_liquidity") {
    return {
      maxFormalSpreadPercent: Number(options.maxFormalSpreadPercent) * 0.5,
      maxPositionSizePercentOfEquity: Number(options.maxPositionSizePercentOfEquity) * 0.5
    };
  }
  return {};
}

export function marketRegimeScoreAdjustment(regimeBias, side) {
  if (regimeBias === "risk_on") {
    if (side === "long") return 4;
    if (side === "short") return -4;
  }
  if (regimeBias === "risk_off") {
    if (side === "short") return 4;
    if (side === "long") return -4;
  }
  return 0;
}

export function classifyFilteredSourceQuality(candidate, formalEntryQuality) {
  if (candidate?.sourceSignal?.qualityStatus !== "filtered") {
    return { failure: false, warning: false };
  }
  return formalEntryQuality
    ? { failure: false, warning: true }
    : { failure: true, warning: false };
}

export function sourceAllowsScalpExhaustionBypass(candidate) {
  return candidate?.sourceSignal?.qualityStatus === "actionable";
}

export function hasScalpEntryQuality(candidate) {
  if (sourceAllowsScalpExhaustionBypass(candidate)) return true;
  if (candidate?.technicalConsensus?.[candidate?.side]?.strong) return true;
  const decision = candidate?.scalpDecisionProfile;
  return Boolean(decision?.noSourceMicrostructure && !decision?.noSourceExhaustion?.exhausted);
}

export function netRewardRisk({ targetPercent, stopPercent, roundTripCostPercent } = {}) {
  const target = Number(targetPercent);
  const stop = Number(stopPercent);
  const cost = Math.max(0, Number(roundTripCostPercent) || 0);
  const netTarget = target - cost;
  const netLoss = stop + cost;
  if (![target, stop].every(Number.isFinite) || netTarget <= 0 || netLoss <= 0) return null;
  return round(netTarget / netLoss, 4);
}

export function buildOperationalEntryGuard({
  observeOnly = false,
  requireDerivativesHealthy = false,
  candidates = []
} = {}) {
  const reasons = [];
  if (observeOnly) reasons.push("manual_observe_only");
  const healthyDerivativesCandidates = candidates
    .filter((candidate) => candidate?.derivativesStatus === "ok")
    .length;
  if (requireDerivativesHealthy && healthyDerivativesCandidates === 0) {
    reasons.push("derivatives_unavailable");
  }
  return {
    entryBlocked: reasons.length > 0,
    reason: reasons.join("+") || null,
    healthyDerivativesCandidates,
    evaluatedCandidates: candidates.length
  };
}

export function applyFormalTradeGeometry(candidate, options = {}) {
  const entryPrice = Number(candidate?.entryPrice);
  const atrPercent = Number(candidate?.atrPercent);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(atrPercent) || atrPercent < 0) {
    return { ...candidate };
  }

  const minTargetPercent = finiteOr(options.minTargetPercent, 0.35);
  const maxTargetPercent = Math.max(minTargetPercent, finiteOr(options.maxTargetPercent, 1.2));
  const minStopPercent = finiteOr(options.minStopPercent, 0.25);
  const maxStopPercent = Math.max(minStopPercent, finiteOr(options.maxStopPercent, 0.85));
  const targetAtrFraction = finiteOr(options.targetAtrFraction, 0.85);
  const stopAtrFraction = finiteOr(options.stopAtrFraction, 0.62);
  const roundTripCostPercent = Math.max(0, finiteOr(candidate.roundTripCostPercent, 0));

  const targetPercent = clamp(
    Math.max(minTargetPercent, atrPercent * targetAtrFraction),
    minTargetPercent,
    maxTargetPercent
  );
  const atrStop = atrPercent * stopAtrFraction;
  const structuralStop = candidate.side === "long"
    ? candidate.supportResistance?.support
      ? ((entryPrice - Number(candidate.supportResistance.support)) / entryPrice) * 100
      : atrStop
    : candidate.supportResistance?.resistance
      ? ((Number(candidate.supportResistance.resistance) - entryPrice) / entryPrice) * 100
      : atrStop;
  const stopPercent = clamp(
    Math.min(atrStop * 1.2, Math.max(structuralStop * 0.8, atrStop)),
    minStopPercent,
    maxStopPercent
  );
  const rewardRisk = stopPercent > 0 ? targetPercent / stopPercent : null;
  const netRatio = netRewardRisk({ targetPercent, stopPercent, roundTripCostPercent });

  return {
    ...candidate,
    takeProfit: round(movePrice(entryPrice, candidate.side, targetPercent), 10),
    stopLoss: round(movePrice(entryPrice, candidate.side, -stopPercent), 10),
    targetPercent: round(targetPercent, 4),
    stopPercent: round(stopPercent, 4),
    netTargetPercent: round(targetPercent - roundTripCostPercent, 4),
    netLossPercent: round(stopPercent + roundTripCostPercent, 4),
    rewardRisk: Number.isFinite(rewardRisk) ? round(rewardRisk, 4) : null,
    netRewardRisk: netRatio
  };
}

export function derivativesPeriodForInterval(interval) {
  if (["1m", "3m"].includes(interval)) return "5m";
  return BINANCE_DERIVATIVES_PERIODS.has(interval) ? interval : "15m";
}

function movePrice(price, side, movePercent) {
  const direction = side === "long" ? 1 : -1;
  return price * (1 + direction * (movePercent / 100));
}

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
