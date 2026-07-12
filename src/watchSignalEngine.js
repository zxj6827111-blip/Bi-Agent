import { buildMarketSnapshot, generateSignalsFromSnapshot, reviewSignalsForQuality, screenSignalsForQuality } from "./signalEngine.js";
import { buildSwingAnalysis } from "./swingEngine.js";
import { round } from "./utils.js";

const ACTION_LABELS = {
  spot_buy: "现货买入候选",
  spot_sell: "现货减仓观察",
  long: "合约做多观察",
  short: "合约做空观察",
  wait: "等待"
};

const ACTION_HINTS = {
  spot_buy: "偏看多：等待价格进入入场区并企稳后，才考虑现货买入。",
  spot_sell: "偏看弱：如果已有现货仓位，重点观察减仓/卖出；没有持仓时通常是不要追买。",
  long: "合约偏多：只表示开多候选，必须确认止损、仓位和强平距离，不是立即开仓。",
  short: "合约偏空：只表示开空候选，必须确认止损、仓位和强平距离，不是立即开仓。",
  wait: "没有明确买卖条件，继续等待。"
};

export function buildWatchState({ market, candlesByInterval }) {
  const snapshots = Object.entries(candlesByInterval)
    .filter(([, candles]) => candles.length >= 60)
    .map(([interval, candles]) => buildMarketSnapshot({ market, interval, candles }));

  const rawSignals = snapshots.flatMap(generateSignalsFromSnapshot);
  const signalReviews = reviewSignalsForQuality(rawSignals, snapshots, 8);
  const signals = screenSignalsForQuality(rawSignals, snapshots, 8);
  const exitSignals = rankExitSignals(rawSignals);
  const swing = buildSwingAnalysis({ market, candlesByInterval, snapshots });
  const primary = choosePrimarySignal(signals);
  const mainSnapshot = snapshots.find((snapshot) => snapshot.interval === "1m") || snapshots[0];
  const alert = decorateAlert(primary ? toWatchAlert(primary) : waitAlert(mainSnapshot), market);
  const tradePlan = buildTradePlan({ market, currentPrice: mainSnapshot?.price || market.lastPrice, signalReviews, signals, swing, alert });
  const line = (candlesByInterval["1m"] || candlesByInterval["5m"] || [])
    .slice(-80)
    .map((candle) => ({
      time: candle.closeTime,
      price: round(candle.close)
    }));

  return {
    symbol: market.symbol,
    marketType: market.marketType,
    actualMarketType: market.actualMarketType || market.marketType,
    dataSourceMarketType: market.dataSourceMarketType || market.marketType,
    isFuturesProxy: Boolean(market.isFuturesProxy),
    marketNotice: market.marketNotice || null,
    proxyReason: market.proxyReason || null,
    updatedAt: new Date().toISOString(),
    price: round(mainSnapshot?.price || market.lastPrice),
    trend: mainSnapshot?.trend || "unknown",
    indicators: mainSnapshot?.indicators || {},
    indicatorState: mainSnapshot?.indicatorState || {},
    technicalConsensus: mainSnapshot?.technicalConsensus || {},
    supportResistance: mainSnapshot?.supportResistance || {},
    fundingRate: market.fundingRate,
    derivatives: market.derivatives || mainSnapshot?.derivatives || null,
    spotContext: market.spotContext || mainSnapshot?.spotContext || null,
    futuresContext: market.futuresContext || mainSnapshot?.futuresContext || null,
    fusion: market.fusion || mainSnapshot?.fusion || null,
    microstructure: market.microstructure || mainSnapshot?.microstructure || null,
    marketRegime: market.marketRegime || mainSnapshot?.marketRegime || null,
    directionAnalysis: market.directionAnalysis || mainSnapshot?.directionAnalysis || null,
    line,
    snapshots,
    alert,
    signals,
    signalReviews,
    exitSignals,
    swing,
    tradePlan
  };
}

function buildTradePlan({ market, currentPrice, signalReviews = [], signals = [], swing = {}, alert = {} }) {
  const marketType = market?.marketType || "spot";
  const longSignal = pickReviewedSignal(signalReviews, marketType === "spot" ? ["spot_buy", "long"] : ["long", "spot_buy"]);
  const shortSignal = pickReviewedSignal(signalReviews, marketType === "spot" ? ["spot_sell", "short"] : ["short", "spot_sell"]);
  const active = signals[0] || null;
  const buy = buildPlanSide({
    side: "long",
    title: marketType === "spot" ? "买入观察位" : "开多观察位",
    signal: longSignal,
    zone: swing?.bottom?.zoneRange,
    swingLeg: swing?.bottom,
    currentPrice
  });
  const sell = buildPlanSide({
    side: "short",
    title: marketType === "spot" ? "卖出观察位" : "开空/卖出观察位",
    signal: shortSignal,
    zone: swing?.top?.zoneRange,
    swingLeg: swing?.top,
    currentPrice
  });
  const conclusion = tradePlanConclusion({ market, alert, active, buy, sell, swing });

  return {
    conclusion,
    currentPrice: round(currentPrice),
    validation: active ? "actionable" : "watch_only",
    buy,
    sell,
    note: market?.isFuturesProxy
      ? "当前合约行情不可用，系统使用现货 K 线代理方向；开仓前必须到交易所确认真实合约盘口、资金费率和强平距离。"
      : "买卖点计划用于观察和提醒，不代表系统已经自动下单。"
  };
}

function buildPlanSide({ side, title, signal, zone, swingLeg = {}, currentPrice }) {
  const actionable = signal?.quality?.status === "actionable";
  const confirmed = Boolean(swingLeg?.confirmed);
  const zoneRange = signal?.entryRange || zone || null;
  const status = actionable ? "ready" : confirmed || isPriceInRange(currentPrice, zoneRange) ? "watch" : "wait";
  const blockers = actionable
    ? []
    : (signal?.quality?.problems || []).slice(0, 3);

  return {
    side,
    title,
    status,
    statusLabel: planStatusLabel(status),
    zoneRange,
    signalEntryRange: signal?.entryRange || null,
    stopLoss: signal?.stopLoss ?? null,
    takeProfit: signal?.takeProfit || null,
    score: signal?.score ?? swingLeg?.score ?? 0,
    riskReward: signal?.riskReward ?? null,
    trigger: buildPlanTrigger({ side, status, zoneRange, currentPrice, swingLeg, signal }),
    blockers,
    reasons: [
      ...((swingLeg?.reasons || []).slice(0, 2)),
      ...((signal?.quality?.notes || []).slice(0, 1))
    ].filter(Boolean)
  };
}

function tradePlanConclusion({ market, alert, active, buy, sell, swing }) {
  if (active && alert.direction !== "wait") {
    return `正式信号已达标：${alert.action || active.directionLabel || "候选信号"}。`;
  }

  if (sell.status === "watch" && swing?.top?.confirmed) {
    return market?.marketType === "futures"
      ? "当前在高点开空/卖出观察区，但正式开空未达标；不要追多，等待转弱确认。"
      : "当前在高点卖出观察区，但正式卖出信号未达标；已有仓位可重点看减仓确认。";
  }

  if (buy.status === "watch" && swing?.bottom?.confirmed) {
    return market?.marketType === "futures"
      ? "当前在低点开多观察区，但正式开多未达标；等待放量和周期确认。"
      : "当前在低点买入观察区，但正式买入未达标；等待企稳确认。";
  }

  return "当前没有正式买入/卖出信号，只显示观察区和下一步触发条件。";
}

function buildPlanTrigger({ side, status, zoneRange, currentPrice, swingLeg = {}, signal = null }) {
  if (!zoneRange?.length) {
    return side === "long"
      ? "等待价格回到低点区并出现量能/趋势确认。"
      : "等待价格进入高点区并出现转弱确认。";
  }

  const [low, high] = zoneRange.map(Number).sort((a, b) => a - b);
  const price = Number(currentPrice);
  const zoneText = `${round(low)} - ${round(high)}`;
  const problem = signal?.quality?.problems?.[0];

  if (status === "ready") {
    return `已达标，参考区间 ${zoneText}，仍需人工确认盘口和止损。`;
  }

  if (side === "long") {
    if (Number.isFinite(price) && price > high) return `买点等待：价格回落到 ${zoneText}，并消除未达标原因后再考虑。`;
    if (Number.isFinite(price) && price < low) return `买点等待：价格重新站回 ${zoneText} 并企稳后再考虑。`;
    return `价格已在低点观察区 ${zoneText}，还需确认：${problem || swingLeg.label || "量能和高周期方向"}`;
  }

  if (Number.isFinite(price) && price < low) return `卖点等待：价格反弹到 ${zoneText}，并出现转弱确认后再考虑。`;
  if (Number.isFinite(price) && price > high) return `卖点观察：价格高于 ${zoneText}，等待跌回区间或放量转弱。`;
  return `价格已在高点观察区 ${zoneText}，还需确认：${problem || swingLeg.label || "短周期转弱和高周期配合"}`;
}

function pickReviewedSignal(reviews, directions) {
  return reviews
    .filter((signal) => directions.includes(signal.direction))
    .sort((a, b) => {
      const actionable = Number(b.quality?.status === "actionable") - Number(a.quality?.status === "actionable");
      if (actionable !== 0) return actionable;
      return Number(b.score || 0) - Number(a.score || 0);
    })[0] || null;
}

function planStatusLabel(status) {
  if (status === "ready") return "可固定提醒";
  if (status === "watch") return "观察中";
  return "等待";
}

function isPriceInRange(price, range) {
  if (!Number.isFinite(Number(price)) || !Array.isArray(range) || range.length !== 2) return false;
  const [low, high] = range.map(Number).sort((a, b) => a - b);
  return Number(price) >= low && Number(price) <= high;
}

function rankExitSignals(signals) {
  return signals
    .filter((signal) => signal.score >= 68)
    .sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      return weightTimeframe(b.timeframe) - weightTimeframe(a.timeframe);
    })
    .slice(0, 8);
}

function choosePrimarySignal(signals) {
  if (!signals.length) return null;
  return signals
    .filter((signal) => signal.score >= 60)
    .sort((a, b) => {
      const timeframeWeight = weightTimeframe(b.timeframe) - weightTimeframe(a.timeframe);
      if (timeframeWeight !== 0) return timeframeWeight;
      return b.score - a.score;
    })[0] || null;
}

function toWatchAlert(signal) {
  return {
    action: ACTION_LABELS[signal.direction] || "观察",
    actionHint: ACTION_HINTS[signal.direction] || "观察信号需要二次确认，不代表立即下单。",
    direction: signal.direction,
    label: signal.directionLabel,
    timeframe: signal.timeframe,
    score: signal.score,
    riskLevel: signal.riskLevel,
    entryRange: signal.entryRange,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    riskReward: signal.riskReward,
    reasons: signal.reasons,
    riskNotes: signal.riskNotes,
    invalidCondition: signal.invalidCondition
  };
}

function waitAlert(snapshot) {
  const isFutures = snapshot?.marketType === "futures";
  return {
    action: isFutures ? "合约等待" : "等待",
    actionHint: isFutures ? "合约暂无明确多空条件，继续等待，不要为了开仓而开仓。" : ACTION_HINTS.wait,
    direction: "wait",
    label: isFutures ? "合约等待" : "等待",
    timeframe: snapshot?.interval || "-",
    score: 0,
    riskLevel: "中",
    entryRange: null,
    stopLoss: null,
    takeProfit: null,
    riskReward: null,
    reasons: [isFutures ? "当前没有达到明确多空条件，继续观察支撑压力、成交量和短周期动能。" : "当前没有达到明确买卖条件，继续观察支撑压力和成交量变化。"],
    riskNotes: [isFutures ? "合约没有信号时避免强行开多或开空，尤其不要用高杠杆试单。" : "没有信号时避免强行交易。"],
    invalidCondition: "等待下一次价格接近关键支撑或压力。"
  };
}

function decorateAlert(alert, market) {
  const next = {
    ...alert,
    reasons: [...(alert.reasons || [])],
    riskNotes: [...(alert.riskNotes || [])]
  };

  if (market.marketType === "futures") {
    next.riskNotes.push("合约信号只做多空候选提示，不是立即开仓指令；必须先确认止损、仓位和强平距离。");
  }

  if (market.isFuturesProxy) {
    next.reasons.push("当前 Binance 合约接口受限，系统使用现货 K 线代理判断合约多空方向。");
    next.riskNotes.push("代理行情不包含真实合约盘口、资金费率和持仓数据，开仓前必须在交易所二次确认。");
  }

  return {
    ...next,
    reasons: [...new Set(next.reasons)],
    riskNotes: [...new Set(next.riskNotes)]
  };
}

function weightTimeframe(timeframe) {
  if (timeframe === "15m") return 3;
  if (timeframe === "5m") return 2;
  if (timeframe === "1m") return 1;
  return 0;
}
