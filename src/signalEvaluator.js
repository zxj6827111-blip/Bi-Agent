import { round } from "./utils.js";
import { config } from "./config.js";
import { netResultPercent, resultPercent as calculateResultPercent } from "./tradeMetrics.js";

const HORIZONS = [4, 24];
const EVALUATION_INTERVAL = "15m";
const MAX_EVALUATED_SIGNALS_PER_SESSION = 12;

export async function evaluateSignalsForSession({ session, client, now = Date.now() }) {
  const evaluations = [];
  for (const signal of (session.signals || []).slice(0, MAX_EVALUATED_SIGNALS_PER_SESSION)) {
    for (const horizonHours of HORIZONS) {
      evaluations.push(await evaluateSignal({ session, signal, client, horizonHours, now }));
    }
  }
  return evaluations;
}

export async function evaluateSignal({ session, signal, client, horizonHours, now = Date.now() }) {
  const startTime = new Date(session.endTime || session.startTime).getTime();
  const endTime = startTime + horizonHours * 60 * 60 * 1000;
  const id = `${session.id}:${signal.id}:${horizonHours}h`;

  if (!Number.isFinite(startTime) || now < endTime) {
    return pendingEvaluation({ id, session, signal, horizonHours, reason: "horizon_not_reached" });
  }

  try {
    const candles = await client.getKlines(signal.marketType, signal.symbol, EVALUATION_INTERVAL, 1000, {
      startTime,
      endTime
    });
    return evaluateFromCandles({ id, session, signal, horizonHours, candles });
  } catch (error) {
    return pendingEvaluation({ id, session, signal, horizonHours, reason: error.message });
  }
}

export function evaluateFromCandles({ id, session, signal, horizonHours, candles }) {
  if (!candles?.length) {
    return pendingEvaluation({ id, session, signal, horizonHours, reason: "no_candles" });
  }

  const isShort = signal.direction === "short" || signal.direction === "spot_sell";
  const [entryLow, entryHigh] = signal.entryRange.map(Number).sort((a, b) => a - b);
  const stop = Number(signal.stopLoss);
  const tp1 = Number(signal.takeProfit?.tp1);
  const tp2 = Number(signal.takeProfit?.tp2);
  const firstEntry = candles.find((candle) => candle.low <= entryHigh && candle.high >= entryLow);

  if (!firstEntry) {
    const last = candles.at(-1);
    return completedEvaluation({
      id,
      session,
      signal,
      horizonHours,
      outcome: "no_entry",
      entryTouched: false,
      entryTime: null,
      exitTime: last ? new Date(last.closeTime).toISOString() : null,
      exitPrice: last?.close ?? null,
      maxFavorablePercent: 0,
      maxAdversePercent: 0,
      resultPercent: 0,
      details: { candles: candles.length }
    });
  }

  const entryMid = (entryLow + entryHigh) / 2;
  let maxFavorablePercent = 0;
  let maxAdversePercent = 0;
  let outcome = "expired";
  let exitTime = null;
  let exitPrice = null;

  for (const candle of candles.filter((item) => item.closeTime >= firstEntry.closeTime)) {
    const favorable = isShort
      ? ((entryMid - candle.low) / entryMid) * 100
      : ((candle.high - entryMid) / entryMid) * 100;
    const adverse = isShort
      ? ((candle.high - entryMid) / entryMid) * 100
      : ((entryMid - candle.low) / entryMid) * 100;
    maxFavorablePercent = Math.max(maxFavorablePercent, favorable);
    maxAdversePercent = Math.max(maxAdversePercent, adverse);

    const stopHit = isShort ? candle.high >= stop : candle.low <= stop;
    const tp2Hit = Number.isFinite(tp2) && (isShort ? candle.low <= tp2 : candle.high >= tp2);
    const tp1Hit = Number.isFinite(tp1) && (isShort ? candle.low <= tp1 : candle.high >= tp1);

    if (stopHit) {
      outcome = "stop";
      exitTime = new Date(candle.closeTime).toISOString();
      exitPrice = stop;
      break;
    }
    if (tp2Hit) {
      outcome = "tp2";
      exitTime = new Date(candle.closeTime).toISOString();
      exitPrice = tp2;
      break;
    }
    if (tp1Hit) {
      outcome = "tp1";
      exitTime = new Date(candle.closeTime).toISOString();
      exitPrice = tp1;
      break;
    }
  }

  if (!exitTime) {
    const last = candles.at(-1);
    exitTime = last ? new Date(last.closeTime).toISOString() : null;
    exitPrice = last?.close ?? null;
  }

  return completedEvaluation({
    id,
    session,
    signal,
    horizonHours,
    outcome,
    entryTouched: true,
    entryTime: new Date(firstEntry.closeTime).toISOString(),
    exitTime,
    exitPrice,
    maxFavorablePercent,
    maxAdversePercent,
    resultPercent: calculateResultPercent({ direction: signal.direction, entryPrice: entryMid, exitPrice }),
    details: { candles: candles.length, entryMid }
  });
}

function pendingEvaluation({ id, session, signal, horizonHours, reason }) {
  return baseEvaluation({ id, session, signal, horizonHours, status: "pending", outcome: "pending" }, {
    entryTouched: false,
    entryTime: null,
    exitTime: null,
    exitPrice: null,
    maxFavorablePercent: null,
    maxAdversePercent: null,
    resultPercent: null,
    details: { reason }
  });
}

function completedEvaluation(payload) {
  const costAdjusted = netResultPercent({
    grossResultPercent: payload.resultPercent,
    marketType: payload.signal.marketType,
    entryTouched: payload.entryTouched,
    costs: config.tradingCosts
  }) || {};

  return baseEvaluation({ ...payload, status: "completed" }, {
    entryTouched: payload.entryTouched,
    entryTime: payload.entryTime,
    exitTime: payload.exitTime,
    exitPrice: round(payload.exitPrice),
    maxFavorablePercent: round(payload.maxFavorablePercent, 4),
    maxAdversePercent: round(payload.maxAdversePercent, 4),
    resultPercent: round(payload.resultPercent, 4),
    grossResultPercent: costAdjusted.grossResultPercent ?? round(payload.resultPercent, 4),
    netResultPercent: costAdjusted.netResultPercent ?? round(payload.resultPercent, 4),
    feePercent: costAdjusted.feePercent ?? 0,
    slippagePercent: costAdjusted.slippagePercent ?? 0,
    details: {
      ...payload.details,
      costModel: {
        feePercent: costAdjusted.feePercent ?? 0,
        slippagePercent: costAdjusted.slippagePercent ?? 0,
        totalCostPercent: costAdjusted.totalCostPercent ?? 0
      }
    }
  });
}

function baseEvaluation({ id, session, signal, horizonHours, status, outcome }, extra) {
  return {
    id,
    sessionId: session.id,
    signalId: signal.id,
    symbol: signal.symbol,
    marketType: signal.marketType,
    direction: signal.direction,
    timeframe: signal.timeframe,
    horizonHours,
    status,
    outcome,
    ...extra
  };
}
