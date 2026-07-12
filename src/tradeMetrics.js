import { round } from "./utils.js";

export function isShortLike(direction) {
  return direction === "short" || direction === "spot_sell";
}

export function resultPercent({ direction, entryPrice, exitPrice }) {
  const entry = Number(entryPrice);
  const exit = Number(exitPrice);
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry === 0) return null;
  return isShortLike(direction)
    ? ((entry - exit) / entry) * 100
    : ((exit - entry) / entry) * 100;
}

export function estimateRoundTripCostPercent({ marketType, entryTouched, costs }) {
  if (!entryTouched) {
    return {
      feePercent: 0,
      slippagePercent: 0,
      totalCostPercent: 0
    };
  }

  const oneSideFeeRate = marketType === "futures"
    ? Number(costs?.futuresFeeRate ?? 0)
    : Number(costs?.spotFeeRate ?? 0);
  const oneSideFeePercent = Number.isFinite(oneSideFeeRate) ? oneSideFeeRate * 100 : 0;
  const oneSideSlippagePercent = Number(costs?.slippagePercent ?? 0);
  const feePercent = Math.max(0, oneSideFeePercent * 2);
  const slippagePercent = Math.max(0, (Number.isFinite(oneSideSlippagePercent) ? oneSideSlippagePercent : 0) * 2);

  return {
    feePercent: round(feePercent, 4),
    slippagePercent: round(slippagePercent, 4),
    totalCostPercent: round(feePercent + slippagePercent, 4)
  };
}

export function netResultPercent({ grossResultPercent, marketType, entryTouched, costs }) {
  const gross = Number(grossResultPercent);
  if (!Number.isFinite(gross)) return null;
  const cost = estimateRoundTripCostPercent({ marketType, entryTouched, costs });
  return {
    grossResultPercent: round(gross, 4),
    netResultPercent: round(gross - cost.totalCostPercent, 4),
    ...cost
  };
}

export function summarizePerformance(items, valueFn = defaultResultValue) {
  const results = items
    .map(valueFn)
    .map(Number)
    .filter(Number.isFinite);
  const wins = results.filter((value) => value > 0);
  const losses = results.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = losses.reduce((sum, value) => sum + Math.abs(value), 0);

  return {
    avgNetResultPercent: results.length ? grossResultAverage(results) : 0,
    expectancyPercent: results.length ? grossResultAverage(results) : 0,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : wins.length ? null : 0,
    grossProfitPercent: round(grossProfit, 4),
    grossLossPercent: round(grossLoss, 4),
    maxDrawdownPercent: maxDrawdownPercent(results)
  };
}

function defaultResultValue(item) {
  return item.netResultPercent !== null
    && item.netResultPercent !== undefined
    && Number.isFinite(Number(item.netResultPercent))
    ? Number(item.netResultPercent)
    : Number(item.resultPercent || 0);
}

function grossResultAverage(values) {
  return round(values.reduce((sum, value) => sum + value, 0) / values.length, 4);
}

function maxDrawdownPercent(results) {
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of results) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return round(maxDrawdown, 4);
}
