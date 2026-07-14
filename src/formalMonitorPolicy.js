import { realizedAccountReturnPercent } from "./portfolioRisk.js";
import { round } from "./utils.js";

const BINANCE_DERIVATIVES_PERIODS = new Set(["5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"]);

export function hardExitOutcome(position, exitPrice) {
  if (exitPrice == null || position?.takeProfit == null || position?.stopLoss == null) return null;
  const price = Number(exitPrice);
  const takeProfit = Number(position?.takeProfit);
  const stopLoss = Number(position?.stopLoss);
  if (![price, takeProfit, stopLoss].every((value) => Number.isFinite(value) && value > 0)) return null;

  if (position.side === "long") {
    if (price >= takeProfit) return "tp";
    if (price <= stopLoss) return "stop";
  } else if (position.side === "short") {
    if (price <= takeProfit) return "tp";
    if (price >= stopLoss) return "stop";
  }
  return null;
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
      confirmationScans: Math.min(Number(options.confirmationScans) + 1, 4),
      executionMaxSoftFailures: Math.max(0, Number(options.executionMaxSoftFailures) - 1)
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

export function derivativesPeriodForInterval(interval) {
  if (["1m", "3m"].includes(interval)) return "5m";
  return BINANCE_DERIVATIVES_PERIODS.has(interval) ? interval : "15m";
}
