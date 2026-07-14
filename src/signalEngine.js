import {
  adx,
  atr,
  bollingerBands,
  closedCandles,
  macd,
  rsi,
  sma,
  summarizeIndicatorState,
  supportResistance,
  volumeRatio,
  vwap
} from "./indicators.js";
import { directionBlocksSignal, directionScoreAdjustment } from "./directionEngine.js";
import { fusionBlocksSignal, fusionScoreAdjustment } from "./marketFusion.js";
import { clamp, percent, round } from "./utils.js";

const DIRECTION_LABELS = {
  spot_buy: "现货买入候选",
  spot_sell: "现货减仓观察",
  long: "合约做多候选",
  short: "合约做空候选"
};

const EXCLUDED_BASE_ASSETS = new Set([
  "USDC",
  "FDUSD",
  "TUSD",
  "BUSD",
  "USDP",
  "USD1",
  "USDE",
  "USDD",
  "USDS",
  "USTC",
  "DAI",
  "RLUSD",
  "EUR",
  "TRY",
  "BRL",
  "GBP",
  "AUD",
  "ARS",
  "AEUR",
  "EURI"
]);

const TIMEFRAME_WEIGHT = {
  "1m": 1,
  "5m": 2,
  "15m": 3,
  "1h": 4,
  "4h": 5,
  "1d": 6
};

const MIN_ACTIONABLE_SCORE = 70;
const MIN_ACTIONABLE_RISK_REWARD = 1.15;
const SPOT_BUY_MIN_ACTIONABLE_SCORE = 74;
const SPOT_BUY_MIN_RISK_REWARD = 1.35;
const SPOT_SELL_MIN_ACTIONABLE_SCORE = 70;
const SPOT_SELL_MIN_RISK_REWARD = 1;
const DIRECT_SIGNAL_TIMEFRAMES = new Set(["1m", "5m", "15m", "1h"]);
const TRADE_DIRECTIONS = new Set(["spot_buy", "spot_sell", "long", "short"]);

export function filterTradableSymbols(symbols, { minQuoteVolume, maxSpreadPercent }) {
  return symbols
    .filter((item) => !EXCLUDED_BASE_ASSETS.has(item.baseAsset))
    .filter((item) => item.lastPrice > 0)
    .filter((item) => item.quoteVolume >= minQuoteVolume)
    .filter((item) => item.spreadPercent <= maxSpreadPercent)
    .sort((a, b) => b.quoteVolume - a.quoteVolume);
}

export function buildMarketSnapshot({ market, interval, candles, nowMs = Date.now() }) {
  const rawCandles = Array.isArray(candles) ? candles : [];
  const finalizedCandles = closedCandles(rawCandles, nowMs);
  if (finalizedCandles.length < 2) {
    throw new Error(`Not enough closed candles for ${market?.symbol || "unknown"} ${interval}`);
  }

  const closes = finalizedCandles.map((candle) => candle.close);
  const latest = finalizedCandles[finalizedCandles.length - 1];
  const previous = finalizedCandles[finalizedCandles.length - 2] || latest;
  const atrValue = atr(finalizedCandles);
  const sr = supportResistance(finalizedCandles);
  const macdValue = macd(closes);
  const rsiValue = rsi(closes);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const volRatio = volumeRatio(finalizedCandles);
  const bollinger = bollingerBands(closes);
  const adxValue = adx(finalizedCandles);
  const vwapValue = vwap(finalizedCandles);
  const indicatorState = summarizeIndicatorState({ closes, candles: finalizedCandles, macdValue, rsiValue, bollinger, atrValue });
  const changeFromPrevious = previous.close ? ((latest.close - previous.close) / previous.close) * 100 : 0;
  const resistanceDistance = sr.resistance ? ((sr.resistance - latest.close) / latest.close) * 100 : null;
  const supportDistance = sr.support ? ((latest.close - sr.support) / latest.close) * 100 : null;
  const trend = inferTrend({ price: latest.close, sma20, sma50, macdHistogram: macdValue.histogram });
  const technicalConsensus = buildTechnicalConsensus({
    trend,
    indicatorState,
    rsiValue,
    volume: volRatio,
    candleChangePercent: changeFromPrevious
  });

  return {
    symbol: market.symbol,
    marketType: market.marketType,
    actualMarketType: market.actualMarketType || market.marketType,
    dataSourceMarketType: market.dataSourceMarketType || market.marketType,
    isFuturesProxy: Boolean(market.isFuturesProxy),
    marketNotice: market.marketNotice || null,
    interval,
    price: latest.close,
    quoteVolume: market.quoteVolume,
    spreadPercent: market.spreadPercent,
    priceChangePercent24h: market.priceChangePercent,
    fundingRate: market.derivatives?.fundingRate ?? market.fundingRate,
    spotContext: market.spotContext || null,
    futuresContext: market.futuresContext || null,
    derivatives: market.derivatives || null,
    fusion: market.fusion || null,
    microstructure: market.microstructure || null,
    marketRegime: market.marketRegime || null,
    directionAnalysis: market.directionAnalysis || null,
    candleWindow: {
      inputCandles: rawCandles.length,
      usedClosedCandles: finalizedCandles.length,
      droppedUnclosedCandles: rawCandles.length - finalizedCandles.length,
      latestClosedAt: Number.isFinite(Number(latest.closeTime)) ? new Date(Number(latest.closeTime)).toISOString() : null
    },
    indicators: {
      rsi: round(rsiValue, 2),
      macd: round(macdValue.macd, 8),
      macdSignal: round(macdValue.signal, 8),
      macdHistogram: round(macdValue.histogram, 8),
      sma20: round(sma20),
      sma50: round(sma50),
      atr: round(atrValue),
      volumeRatio: round(volRatio, 2),
      bollingerUpper: round(bollinger.upper),
      bollingerMiddle: round(bollinger.middle),
      bollingerLower: round(bollinger.lower),
      bollingerBandwidthPercent: round(bollinger.bandwidthPercent, 2),
      bollingerPercentB: round(bollinger.percentB, 3),
      adx: adxValue.adx,
      adxPlusDI: adxValue.plusDI,
      adxMinusDI: adxValue.minusDI
    },
    indicatorState,
    technicalConsensus,
    supportResistance: {
      support: round(sr.support),
      resistance: round(sr.resistance),
      supportDistancePercent: round(supportDistance, 2),
      resistanceDistancePercent: round(resistanceDistance, 2)
    },
    vwap: vwapValue,
    trend,
    volatilityPercent: atrValue && latest.close ? round((atrValue / latest.close) * 100, 2) : null,
    candleChangePercent: round(changeFromPrevious, 2)
  };
}

function buildTechnicalConsensus({ trend, indicatorState, rsiValue, volume, candleChangePercent }) {
  const longChecks = [
    trend === "up" || trend === "recovering",
    indicatorState.macdTrend === "bullish",
    rsiValue >= 45 && rsiValue <= 68,
    volume >= 1.05,
    !["bullish_fakeout_risk", "bullish_rejection"].includes(indicatorState.breakoutBias)
  ];
  const shortChecks = [
    trend === "down" || trend === "weakening",
    indicatorState.macdTrend === "bearish",
    rsiValue >= 52 || rsiValue <= 45,
    volume >= 1.05,
    !["bearish_fakeout_risk", "bearish_reclaim"].includes(indicatorState.breakoutBias)
  ];
  const longConfirmations = longChecks.filter(Boolean).length;
  const shortConfirmations = shortChecks.filter(Boolean).length;

  return {
    bias: longConfirmations - shortConfirmations >= 2
      ? "bullish"
      : shortConfirmations - longConfirmations >= 2
        ? "bearish"
        : "neutral",
    long: {
      confirmations: longConfirmations,
      trendAligned: longChecks[0],
      macdAligned: longChecks[1],
      rsiHealthy: longChecks[2],
      volumeConfirmed: longChecks[3],
      fakeBreakoutRisk: !longChecks[4],
      strong: longConfirmations >= 4,
      allowed: longConfirmations >= 3 && longChecks[4] && candleChangePercent > -2.5
    },
    short: {
      confirmations: shortConfirmations,
      trendAligned: shortChecks[0],
      macdAligned: shortChecks[1],
      rsiHealthy: shortChecks[2],
      volumeConfirmed: shortChecks[3],
      fakeBreakoutRisk: !shortChecks[4],
      strong: shortConfirmations >= 4,
      allowed: shortConfirmations >= 3 && shortChecks[4] && candleChangePercent < 2.5
    }
  };
}

function buildAtrTradePlan({ snapshot, direction, latestPrice, atrValue, support, resistance }) {
  const isShort = direction === "short" || direction === "spot_sell";
  const volatility = Number(snapshot.volatilityPercent || 0);
  const volatilityBoost = volatility >= 4 ? 0.25 : volatility >= 2.5 ? 0.12 : 0;
  const stopMultiple = 1.15 + volatilityBoost;
  const tp1Multiple = 1.75 + volatilityBoost * 0.8;
  const tp2Multiple = 2.9 + volatilityBoost * 1.2;
  const entryPullback = isShort ? [0.12, 0.36] : [0.36, 0.18];
  const atrStop = isShort ? latestPrice + atrValue * stopMultiple : latestPrice - atrValue * stopMultiple;
  const structuralStop = isShort && resistance ? resistance * 1.005 : !isShort && support ? support * 0.995 : null;
  const rawStop = structuralStop
    ? isShort ? Math.min(structuralStop, atrStop) : Math.max(structuralStop, atrStop)
    : isShort ? latestPrice + atrValue * (stopMultiple + 0.2) : latestPrice - atrValue * (stopMultiple + 0.25);
  const atrTp1 = isShort ? latestPrice - atrValue * tp1Multiple : latestPrice + atrValue * tp1Multiple;
  const structuralTp1 = isShort && support && support < latestPrice
    ? support * 1.005
    : !isShort && resistance && resistance > latestPrice
      ? resistance * 0.995
      : null;
  const rawTp1 = structuralTp1
    ? isShort ? Math.min(structuralTp1, atrTp1) : Math.max(structuralTp1, atrTp1)
    : atrTp1;

  if (isShort) {
    return {
      entry: [latestPrice - atrValue * entryPullback[0], latestPrice + atrValue * entryPullback[1]],
      stop: rawStop,
      tp1: rawTp1,
      tp2: latestPrice - atrValue * tp2Multiple
    };
  }

  return {
    entry: [latestPrice - atrValue * entryPullback[0], latestPrice + atrValue * entryPullback[1]],
    stop: rawStop,
    tp1: rawTp1,
    tp2: latestPrice + atrValue * tp2Multiple
  };
}

export function generateSignalsFromSnapshot(snapshot) {
  if (!DIRECT_SIGNAL_TIMEFRAMES.has(snapshot.interval)) {
    return [];
  }

  const signals = [];
  const latestPrice = snapshot.price;
  const atrValue = snapshot.indicators.atr || latestPrice * 0.01;
  const rsiValue = snapshot.indicators.rsi;
  const volume = snapshot.indicators.volumeRatio || 1;
  const histogram = snapshot.indicators.macdHistogram || 0;
  const support = snapshot.supportResistance.support;
  const resistance = snapshot.supportResistance.resistance;
  const volatility = snapshot.volatilityPercent || 0;

  if (snapshot.marketType === "spot") {
    const buyPlan = buildAtrTradePlan({ snapshot, direction: "spot_buy", latestPrice, atrValue, support, resistance });
    const buyScore = scoreLongSetup({ snapshot, rsiValue, volume, histogram })
      + fusionScoreAdjustment(snapshot.fusion, "spot_buy", snapshot)
      + directionScoreAdjustment(snapshot.directionAnalysis, "spot_buy");
    if (buyScore >= 58) {
      signals.push(makeSignal({
        snapshot,
        direction: "spot_buy",
        score: buyScore,
        entry: buyPlan.entry,
        stop: buyPlan.stop,
        tp1: buyPlan.tp1,
        tp2: buyPlan.tp2,
        reasons: buildLongReasons(snapshot),
        invalidCondition: "跌破短线支撑且放量走弱，或 RSI 快速跌回 45 以下。"
      }));
    }

    const sellPlan = buildAtrTradePlan({ snapshot, direction: "spot_sell", latestPrice, atrValue, support, resistance });
    const sellScore = scoreSellSetup({ snapshot, rsiValue, volume, histogram })
      + fusionScoreAdjustment(snapshot.fusion, "spot_sell", snapshot)
      + directionScoreAdjustment(snapshot.directionAnalysis, "spot_sell");
    if (sellScore >= 58) {
      signals.push(makeSignal({
        snapshot,
        direction: "spot_sell",
        score: sellScore,
        entry: sellPlan.entry,
        stop: sellPlan.stop,
        tp1: sellPlan.tp1,
        tp2: sellPlan.tp2,
        reasons: buildShortReasons(snapshot, true),
        invalidCondition: "重新站上压力位并且 MACD 柱转强时，卖出观察信号失效。"
      }));
    }
  }

  if (snapshot.marketType === "futures") {
    const longPlan = buildAtrTradePlan({ snapshot, direction: "long", latestPrice, atrValue, support, resistance });
    const longScore = scoreLongSetup({ snapshot, rsiValue, volume, histogram })
      + fusionScoreAdjustment(snapshot.fusion, "long", snapshot)
      + directionScoreAdjustment(snapshot.directionAnalysis, "long")
      - fundingPenalty(snapshot, "long");
    if (longScore >= 60) {
      signals.push(makeSignal({
        snapshot,
        direction: "long",
        score: longScore,
        entry: longPlan.entry,
        stop: longPlan.stop,
        tp1: longPlan.tp1,
        tp2: longPlan.tp2,
        reasons: [...buildLongReasons(snapshot), buildFundingReason(snapshot)],
        invalidCondition: "价格跌破支撑、资金费率继续过热或 15m/1h 趋势同时转弱。"
      }));
    }

    const shortPlan = buildAtrTradePlan({ snapshot, direction: "short", latestPrice, atrValue, support, resistance });
    const shortScore = scoreShortSetup({ snapshot, rsiValue, volume, histogram })
      + fusionScoreAdjustment(snapshot.fusion, "short", snapshot)
      + directionScoreAdjustment(snapshot.directionAnalysis, "short")
      - fundingPenalty(snapshot, "short");
    if (shortScore >= 60) {
      signals.push(makeSignal({
        snapshot,
        direction: "short",
        score: shortScore,
        entry: shortPlan.entry,
        stop: shortPlan.stop,
        tp1: shortPlan.tp1,
        tp2: shortPlan.tp2,
        reasons: [...buildShortReasons(snapshot, false), buildFundingReason(snapshot)],
        invalidCondition: "重新站上短线压力且成交量放大，或资金费率转向不利。"
      }));
    }
  }

  return signals
    .filter((signal) => signal.takeProfit.tp1 > 0 && signal.stopLoss > 0)
    .map((signal) => ({
      ...signal,
      riskLevel: inferRiskLevel(signal, volatility),
      riskNotes: buildRiskNotes(signal, snapshot)
    }));
}

export function rankSignals(signals, limit = 30) {
  return signals
    .sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      return b.marketSnapshot.quoteVolume - a.marketSnapshot.quoteVolume;
    })
    .slice(0, limit);
}

export function screenSignalsForQuality(signals, snapshots, limit = 30) {
  return reviewSignalsForQuality(signals, snapshots)
    .filter((signal) => signal.quality.status === "actionable")
    .sort(compareReviewedSignals)
    .slice(0, limit);
}

export function reviewSignalsForQuality(signals, snapshots, limit = 30) {
  return signals
    .map((signal) => attachQualityReview(signal, snapshots))
    .sort(compareReviewedSignals)
    .slice(0, limit);
}

function attachQualityReview(signal, snapshots) {
  const confirmation = inspectTimeframeConfirmation(signal, snapshots);
  const problems = [];
  const notes = [];
  let adjustedScore = signal.score;
  const minRiskReward = minRiskRewardForSignal(signal);
  const minScore = minScoreForSignal(signal);

  if (TRADE_DIRECTIONS.has(signal.direction) && !DIRECT_SIGNAL_TIMEFRAMES.has(signal.timeframe)) {
    problems.push(`${signal.timeframe} 周期只用于方向确认，不直接生成入场信号`);
  }

  if ((signal.riskReward || 0) < minRiskReward) {
    problems.push(`TP1盈亏比 ${signal.riskReward ?? "-"} 低于 ${minRiskReward}`);
  }

  if (signal.score < minScore) {
    problems.push(`规则评分 ${signal.score} 低于 ${minScore}`);
  }

  if (confirmation.supporting.length) {
    adjustedScore += Math.min(8, confirmation.supporting.length * 4);
    notes.push(`获得 ${confirmation.supporting.map((item) => item.interval).join("、")} 周期确认`);
  }

  if (confirmation.opposing.length) {
    const hardOpposing = signal.direction === "spot_sell"
      ? confirmation.opposing.filter((item) => item.trend === "up")
      : confirmation.opposing;
    const softOpposing = confirmation.opposing.filter((item) => !hardOpposing.includes(item));
    adjustedScore -= Math.min(18, hardOpposing.length * 9 + softOpposing.length * 4);
    if (hardOpposing.length) {
      problems.push(`高周期冲突：${hardOpposing.map((item) => `${item.interval} ${trendLabel(item.trend)}`).join("、")}`);
    }
    if (softOpposing.length) {
      notes.push(`高周期仍有修复迹象：${softOpposing.map((item) => `${item.interval} ${trendLabel(item.trend)}`).join("、")}`);
    }
  }

  const technicalReview = inspectTechnicalConfluence(signal);
  adjustedScore += technicalReview.scoreAdjustment;
  notes.push(...technicalReview.notes);
  problems.push(...technicalReview.problems);

  const fusionProblems = fusionBlocksSignal(signal.marketSnapshot?.fusion, signal.direction, signal.marketSnapshot || {});
  if (fusionProblems.length) {
    adjustedScore -= Math.min(16, fusionProblems.length * 6);
    problems.push(...fusionProblems);
  } else if (signal.marketSnapshot?.fusion?.notes?.length) {
    notes.push(...signal.marketSnapshot.fusion.notes.slice(0, 2));
  }

  const directionReview = inspectRealtimeDirection(signal);
  adjustedScore += directionReview.scoreAdjustment;
  notes.push(...directionReview.notes);
  problems.push(...directionReview.problems);

  if (signal.direction === "spot_buy") {
    problems.push(...inspectSpotBuyRisks(signal, confirmation));
  }

  if (signal.direction === "spot_sell") {
    problems.push(...inspectSpotSellRisks(signal, confirmation));
  }

  adjustedScore = clamp(Math.round(adjustedScore), 0, 100);
  if (adjustedScore < minScore) {
    problems.push(`调整后评分 ${adjustedScore} 低于 ${minScore}`);
  }

  const status = problems.length ? "filtered" : "actionable";
  return {
    ...signal,
    ruleScore: signal.score,
    score: adjustedScore,
    quality: {
      status,
      minScore,
      minRiskReward,
      timeframeBias: directionBias(signal.direction),
      timeframeConfirmation: confirmation,
      notes,
      problems
    }
  };
}

function minRiskRewardForSignal(signal) {
  if (signal.direction === "spot_sell") return SPOT_SELL_MIN_RISK_REWARD;
  return signal.direction === "spot_buy" ? SPOT_BUY_MIN_RISK_REWARD : MIN_ACTIONABLE_RISK_REWARD;
}

function minScoreForSignal(signal) {
  if (signal.direction === "spot_sell") return SPOT_SELL_MIN_ACTIONABLE_SCORE;
  return signal.direction === "spot_buy" ? SPOT_BUY_MIN_ACTIONABLE_SCORE : MIN_ACTIONABLE_SCORE;
}

function inspectTechnicalConfluence(signal) {
  const consensus = signal.marketSnapshot?.technicalConsensus;
  if (!consensus) return { scoreAdjustment: 0, notes: [], problems: [] };

  const bias = directionBias(signal.direction);
  const side = bias === "long" ? consensus.long : consensus.short;
  const problems = [];
  const notes = [];
  let scoreAdjustment = 0;

  if (!side?.trendAligned) {
    notes.push("趋势方向未完全共振，降低信号评分。");
    scoreAdjustment -= 3;
  }
  if (!side?.macdAligned) {
    notes.push("MACD 动能未完全共振，降低信号评分。");
    scoreAdjustment -= 3;
  }
  if (!side?.rsiHealthy) {
    notes.push("RSI 状态不够理想，降低信号评分。");
    scoreAdjustment -= 2;
  }
  if (!side?.volumeConfirmed) {
    notes.push("成交量没有明显放大，降低信号评分。");
    scoreAdjustment -= 3;
  }
  if (side?.fakeBreakoutRisk) problems.push("Bollinger 结构提示假突破/假跌破风险。");

  if (side?.confirmations >= 4) {
    scoreAdjustment += 5;
    notes.push(`技术三重确认达标：${side.confirmations}/5`);
  } else if (side?.confirmations >= 3) {
    notes.push(`技术确认基本达标：${side.confirmations}/5`);
  } else {
    scoreAdjustment -= 10;
    problems.push(`技术确认不足：${side?.confirmations ?? 0}/5`);
  }

  if (consensus.bias === "bullish" && bias === "long") scoreAdjustment += 3;
  if (consensus.bias === "bearish" && bias === "short") scoreAdjustment += 3;
  if (consensus.bias === "bullish" && bias === "short") scoreAdjustment -= 5;
  if (consensus.bias === "bearish" && bias === "long") scoreAdjustment -= 5;

  return { scoreAdjustment, notes, problems };
}

function inspectRealtimeDirection(signal) {
  const analysis = signal.marketSnapshot?.directionAnalysis;
  if (!analysis) return { scoreAdjustment: 0, notes: [], problems: [] };

  const problems = directionBlocksSignal(analysis, signal.direction);
  const scoreAdjustment = problems.length ? -12 : Math.max(-8, Math.min(10, directionScoreAdjustment(analysis, signal.direction)));
  const notes = [
    `实时方向引擎：${analysis.direction}，edgeScore ${analysis.edgeScore}，上涨概率 ${Math.round(Number(analysis.probabilityUp || 0) * 100)}%`,
    ...(analysis.evidence || []).slice(0, 2)
  ];

  return { scoreAdjustment, notes, problems };
}

function inspectSpotBuyRisks(signal, confirmation) {
  const problems = [];
  const snapshot = signal.marketSnapshot || {};
  const supportDistance = snapshot.supportResistance?.supportDistancePercent;
  const resistanceDistance = snapshot.supportResistance?.resistanceDistancePercent;
  const rsiValue = snapshot.indicators?.rsi;
  const priceChangePercent24h = Number(snapshot.priceChangePercent24h || 0);
  const volumeRatio = Number(snapshot.indicators?.volumeRatio || 0);
  const volatility = Number(snapshot.volatilityPercent || 0);
  const hasHigherSupport = confirmation.supporting.some((item) => item.interval === "1h" || item.interval === "4h" || item.interval === "1d");

  if (signal.timeframe !== "15m" && signal.timeframe !== "4h") {
    problems.push("现货买入只允许 15m/4h 作为直接入场周期，1h 只做方向确认");
  }

  if (!hasHigherSupport) {
    problems.push("现货买入缺少 1h/4h/1d 同向确认");
  }

  if (Number.isFinite(supportDistance) && supportDistance < 1.3) {
    problems.push(`价格距离支撑约 ${supportDistance}% ，空间过窄，容易被短线噪声扫损`);
  }

  if (Number.isFinite(supportDistance) && supportDistance > 2.2) {
    problems.push(`价格距离支撑约 ${supportDistance}% ，追涨风险偏高`);
  }

  if (Number.isFinite(resistanceDistance) && resistanceDistance < 2) {
    problems.push(`距离上方压力约 ${resistanceDistance}% ，上涨空间不足`);
  }

  if (priceChangePercent24h <= 0) {
    problems.push(`24h 涨跌幅 ${round(priceChangePercent24h, 2)}% 未转强，买入胜率不足`);
  }

  if (priceChangePercent24h > 5 && (!(Number.isFinite(supportDistance) && supportDistance <= 1.5) || volumeRatio < 1.5)) {
    problems.push(`24h 涨幅 ${round(priceChangePercent24h, 2)}% 偏热，等待回踩确认`);
  }

  if (Number.isFinite(rsiValue) && rsiValue >= 64) {
    problems.push(`RSI ${round(rsiValue, 2)} 偏热，不追涨`);
  }

  if (volumeRatio < 1.05) {
    problems.push(`成交量倍率 ${round(volumeRatio, 2)} 不足，缺少买入确认`);
  }

  if (volatility > 4) {
    problems.push(`波动率 ${round(volatility, 2)}% 偏高，容易被插针止损`);
  }

  return problems;
}

function inspectSpotSellRisks(signal, confirmation) {
  const problems = [];
  const snapshot = signal.marketSnapshot || {};
  const supportDistance = snapshot.supportResistance?.supportDistancePercent;
  const rsiValue = snapshot.indicators?.rsi;
  const priceChangePercent24h = Number(snapshot.priceChangePercent24h || 0);
  const volumeRatio = Number(snapshot.indicators?.volumeRatio || 0);
  const hasHigherSupport = signal.timeframe === "1h"
    ? confirmation.supporting.some((item) => item.interval === "4h" || item.interval === "1d")
    : signal.timeframe === "4h"
      ? confirmation.supporting.some((item) => item.interval === "1d")
      : confirmation.supporting.some((item) => item.interval === "1h" || item.interval === "4h" || item.interval === "1d");
  const hasHardHigherUptrend = confirmation.opposing.some((item) => item.trend === "up");
  const hasHigherBearStructure = confirmation.supporting.some((item) => item.trend === "down" || item.trend === "weakening");

  if (signal.timeframe !== "15m" && signal.timeframe !== "4h") {
    problems.push("现货卖出只允许 15m/4h 作为直接提醒周期，1h 只做方向确认");
  }

  if (!hasHigherSupport && hasHardHigherUptrend) {
    problems.push("现货卖出遇到高周期明确上行，减仓优势不足");
  }

  if (!hasHigherBearStructure && !(snapshot.trend === "down" || snapshot.trend === "weakening")) {
    problems.push(`高周期尚未转弱且当前周期趋势未确认下行`);
  }

  if (Number.isFinite(supportDistance) && supportDistance < 1.5) {
    problems.push(`距离下方支撑约 ${supportDistance}% ，下行空间不足`);
  }

  if (priceChangePercent24h < -8 && Number.isFinite(supportDistance) && supportDistance < 3) {
    problems.push(`24h 跌幅 ${round(priceChangePercent24h, 2)}% 已偏深，避免低位追卖`);
  }

  if (Number.isFinite(rsiValue) && rsiValue < 25) {
    problems.push(`RSI ${round(rsiValue, 2)} 已严重超卖，追空风险偏高（警告）`);
  }

  if (volumeRatio < 1.2) {
    problems.push(`成交量倍率 ${round(volumeRatio, 2)} 不足，缺少卖出确认`);
  }

  return problems;
}

function compareReviewedSignals(a, b) {
  const scoreDiff = Number(b.score || 0) - Number(a.score || 0);
  if (scoreDiff !== 0) return scoreDiff;
  const timeframeDiff = timeframePreference(b) - timeframePreference(a);
  if (timeframeDiff !== 0) return timeframeDiff;
  const rrDiff = Number(b.riskReward || 0) - Number(a.riskReward || 0);
  if (rrDiff !== 0) return rrDiff;
  return Number(b.marketSnapshot?.quoteVolume || 0) - Number(a.marketSnapshot?.quoteVolume || 0);
}

function timeframePreference(signal) {
  if (signal.timeframe === "4h") return 5;
  if (signal.timeframe === "1h") return 4;
  if (signal.timeframe === "15m") return 3;
  if (signal.timeframe === "5m") return 2;
  if (signal.timeframe === "1m") return 1;
  return 0;
}

function inspectTimeframeConfirmation(signal, snapshots) {
  const currentWeight = TIMEFRAME_WEIGHT[signal.timeframe] || 0;
  const bias = directionBias(signal.direction);
  const related = snapshots
    .filter((snapshot) => snapshot.symbol === signal.symbol)
    .filter((snapshot) => snapshot.marketType === signal.marketType)
    .filter((snapshot) => (TIMEFRAME_WEIGHT[snapshot.interval] || 0) > currentWeight);

  const supporting = [];
  const opposing = [];
  const neutral = [];

  for (const snapshot of related) {
    if (trendSupportsBias(snapshot.trend, bias)) supporting.push(compactConfirmationSnapshot(snapshot));
    else if (trendOpposesBias(snapshot.trend, bias)) opposing.push(compactConfirmationSnapshot(snapshot));
    else neutral.push(compactConfirmationSnapshot(snapshot));
  }

  return {
    current: signal.timeframe,
    higherTimeframes: related.map((snapshot) => snapshot.interval),
    supporting,
    opposing,
    neutral
  };
}

function compactConfirmationSnapshot(snapshot) {
  return {
    interval: snapshot.interval,
    trend: snapshot.trend,
    scoreContext: {
      rsi: snapshot.indicators.rsi,
      macdHistogram: snapshot.indicators.macdHistogram,
      volumeRatio: snapshot.indicators.volumeRatio
    }
  };
}

function directionBias(direction) {
  if (direction === "spot_buy" || direction === "long") return "long";
  if (direction === "spot_sell" || direction === "short") return "short";
  return "neutral";
}

function trendSupportsBias(trend, bias) {
  if (bias === "long") return trend === "up" || trend === "recovering";
  if (bias === "short") return trend === "down" || trend === "weakening";
  return false;
}

function trendOpposesBias(trend, bias) {
  if (bias === "long") return trend === "down" || trend === "weakening";
  if (bias === "short") return trend === "up" || trend === "recovering";
  return false;
}

function trendLabel(trend) {
  if (trend === "up") return "上行";
  if (trend === "recovering") return "修复";
  if (trend === "down") return "下行";
  if (trend === "weakening") return "转弱";
  if (trend === "range") return "震荡";
  return trend || "未知";
}

function inferTrend({ price, sma20, sma50, macdHistogram }) {
  if (!sma20 || !sma50) return "unknown";
  if (price > sma20 && sma20 > sma50 && macdHistogram > 0) return "up";
  if (price < sma20 && sma20 < sma50 && macdHistogram < 0) return "down";
  if (price > sma20 && macdHistogram >= 0) return "recovering";
  if (price < sma20 && macdHistogram <= 0) return "weakening";
  return "range";
}

function scoreLongSetup({ snapshot, rsiValue, volume, histogram }) {
  let score = 42;
  if (snapshot.trend === "up") score += 18;
  if (snapshot.trend === "recovering") score += 10;
  if (rsiValue >= 48 && rsiValue <= 68) score += 12;
  if (rsiValue < 35) score += 8;
  if (histogram > 0) score += 8;
  if (volume >= 1.4) score += 10;
  if (snapshot.technicalConsensus?.long?.allowed) score += 8;
  if (snapshot.indicatorState?.bollingerState === "lower_reclaim") score += 5;
  if (snapshot.indicatorState?.breakoutBias === "bullish_breakout") score += 4;
  if (["bullish_fakeout_risk", "bullish_rejection"].includes(snapshot.indicatorState?.breakoutBias)) score -= 12;
  if (snapshot.supportResistance.resistanceDistancePercent !== null && snapshot.supportResistance.resistanceDistancePercent > 1) score += 5;
  if (snapshot.spreadPercent > 0.2) score -= 8;
  if ((snapshot.volatilityPercent || 0) > 6) score -= 8;
  return clamp(Math.round(score), 0, 100);
}

function scoreSellSetup({ snapshot, rsiValue, volume, histogram }) {
  let score = 42;
  if (snapshot.trend === "weakening") score += 12;
  if (snapshot.trend === "down") score += 16;
  if (rsiValue >= 70) score += 15;
  if (histogram < 0) score += 8;
  if (volume >= 1.5 && snapshot.candleChangePercent < 0) score += 10;
  if (snapshot.technicalConsensus?.short?.allowed) score += 8;
  if (snapshot.indicatorState?.bollingerState === "upper_rejection") score += 5;
  if (snapshot.indicatorState?.breakoutBias === "bearish_breakdown") score += 4;
  if (["bearish_fakeout_risk", "bearish_reclaim"].includes(snapshot.indicatorState?.breakoutBias)) score -= 12;
  if (snapshot.supportResistance.supportDistancePercent !== null && snapshot.supportResistance.supportDistancePercent > 1) score += 4;
  return clamp(Math.round(score), 0, 100);
}

function scoreShortSetup({ snapshot, rsiValue, volume, histogram }) {
  let score = scoreSellSetup({ snapshot, rsiValue, volume, histogram }) + 4;
  if (snapshot.priceChangePercent24h < -3) score += 5;
  if (snapshot.priceChangePercent24h > 8) score -= 5;
  return clamp(Math.round(score), 0, 100);
}

function fundingPenalty(snapshot, direction) {
  const funding = snapshot.fundingRate || 0;
  if (direction === "long" && funding > 0.0008) return 8;
  if (direction === "short" && funding < -0.0008) return 8;
  return 0;
}

function makeSignal({ snapshot, direction, score, entry, stop, tp1, tp2, reasons, invalidCondition }) {
  const isShort = direction === "short" || direction === "spot_sell";
  const entryMid = (entry[0] + entry[1]) / 2;
  const normalized = normalizeTargets({ isShort, entryMid, stop, tp1, tp2, atrValue: snapshot.indicators.atr || entryMid * 0.01 });
  const loss = isShort ? normalized.stop - entryMid : entryMid - normalized.stop;
  const reward = isShort ? entryMid - normalized.tp1 : normalized.tp1 - entryMid;
  const riskReward = loss ? reward / loss : null;

  return {
    id: `${snapshot.marketType}:${snapshot.symbol}:${snapshot.interval}:${direction}`,
    symbol: snapshot.symbol,
    marketType: snapshot.marketType,
    direction,
    directionLabel: DIRECTION_LABELS[direction],
    timeframe: snapshot.interval,
    entryRange: entry.map((value) => round(value)),
    stopLoss: round(normalized.stop),
    takeProfit: {
      tp1: round(normalized.tp1),
      tp2: round(normalized.tp2)
    },
    riskReward: round(riskReward, 2),
    score: clamp(Math.round(score), 0, 100),
    reasons,
    invalidCondition,
    marketSnapshot: snapshot,
    sideEffect: buildSideEffect(direction)
  };
}

function normalizeTargets({ isShort, entryMid, stop, tp1, tp2, atrValue }) {
  const minMove = Math.max(atrValue * 0.9, entryMid * 0.004);

  if (isShort) {
    const normalizedStop = Math.max(stop, entryMid + minMove);
    const normalizedTp1 = Math.min(tp1, entryMid - minMove);
    const normalizedTp2 = Math.min(tp2, normalizedTp1 - minMove);
    return {
      stop: normalizedStop,
      tp1: Math.max(normalizedTp1, entryMid * 0.0001),
      tp2: Math.max(normalizedTp2, entryMid * 0.0001)
    };
  }

  const normalizedStop = Math.min(stop, entryMid - minMove);
  const normalizedTp1 = Math.max(tp1, entryMid + minMove);
  const normalizedTp2 = Math.max(tp2, normalizedTp1 + minMove);
  return {
    stop: Math.max(normalizedStop, entryMid * 0.0001),
    tp1: normalizedTp1,
    tp2: normalizedTp2
  };
}

function buildSideEffect(direction) {
  if (direction === "short") return "价格继续反弹会放大亏损风险，合约做空需尤其注意强平距离。";
  if (direction === "spot_sell") return "现货卖出观察用于减仓或观望，不代表系统支持做空现货。";
  if (direction === "long") return "合约做多遇到快速跌破支撑时，需要严格控制杠杆和止损。";
  return "突破失败或快速跌破支撑时需要及时放弃信号。";
}

function buildLongReasons(snapshot) {
  const reasons = [];
  if (snapshot.trend === "up") reasons.push("均线结构偏多，价格位于 20/50 均线上方。");
  if (snapshot.trend === "recovering") reasons.push("价格重新站上短均线，有修复迹象。");
  if ((snapshot.indicators.volumeRatio || 0) >= 1.4) reasons.push("近期成交量较均值放大，信号有效性提高。");
  if ((snapshot.indicators.rsi || 0) >= 48 && (snapshot.indicators.rsi || 0) <= 68) reasons.push("RSI 位于相对健康区间，未进入极端追涨状态。");
  if ((snapshot.indicators.macdHistogram || 0) > 0) reasons.push("MACD 柱线偏正，短线动能改善。");
  if (snapshot.technicalConsensus?.long?.allowed) reasons.push("MACD、RSI、Bollinger 与成交量形成多头共振。");
  if (snapshot.fusion?.bias === "bullish") reasons.push("现货盘口、合约持仓/资金费率融合后偏多。");
  if (snapshot.directionAnalysis?.direction === "up") reasons.push(`实时买卖流、盘口和全市场状态偏涨，edgeScore ${snapshot.directionAnalysis.edgeScore}。`);
  reasons.push(...(snapshot.directionAnalysis?.evidence || []).filter((item) => /买入|买盘|偏多|强于/.test(item)).slice(0, 2));
  reasons.push(...(snapshot.fusion?.notes || []).filter((item) => /偏多|买盘|合约/.test(item)).slice(0, 2));
  return reasons.length ? reasons : ["规则引擎发现短线多头候选，但需要等待价格确认。"];
}

function buildShortReasons(snapshot, spotSell) {
  const reasons = [];
  if (snapshot.trend === "down") reasons.push("均线结构偏空，价格位于 20/50 均线下方。");
  if (snapshot.trend === "weakening") reasons.push("价格跌破短均线，短线动能转弱。");
  if ((snapshot.indicators.rsi || 0) >= 70) reasons.push("RSI 进入偏热区间，存在回落风险。");
  if ((snapshot.indicators.macdHistogram || 0) < 0) reasons.push("MACD 柱线偏负，动能转弱。");
  if ((snapshot.indicators.volumeRatio || 0) >= 1.5 && snapshot.candleChangePercent < 0) reasons.push("放量下跌，提高卖出/做空观察价值。");
  if (snapshot.technicalConsensus?.short?.allowed) reasons.push("MACD、RSI、Bollinger 与成交量形成空头共振。");
  if (snapshot.fusion?.bias === "bearish") reasons.push("现货盘口、合约持仓/资金费率融合后偏空。");
  if (snapshot.directionAnalysis?.direction === "down") reasons.push(`实时买卖流、盘口和全市场状态偏跌，edgeScore ${snapshot.directionAnalysis.edgeScore}。`);
  reasons.push(...(snapshot.directionAnalysis?.evidence || []).filter((item) => /卖出|卖盘|偏空|弱于/.test(item)).slice(0, 2));
  reasons.push(...(snapshot.fusion?.notes || []).filter((item) => /偏空|卖盘|合约/.test(item)).slice(0, 2));
  if (spotSell) reasons.push("现货只提示减仓或卖出观察，不代表可做空。");
  return reasons.length ? reasons : ["规则引擎发现短线空头候选，但需要等待价格确认。"];
}

function buildFundingReason(snapshot) {
  if (snapshot.fundingRate === null || snapshot.fundingRate === undefined) return "合约资金费率暂不可用。";
  return `当前资金费率约 ${percent(snapshot.fundingRate, 4)}%，需纳入持仓成本。`;
}

function inferRiskLevel(signal, volatility) {
  if (signal.marketType === "futures" && (volatility >= 5 || signal.riskReward < 1.2)) return "高";
  if (signal.marketType === "futures") return "中高";
  if (volatility >= 5 || signal.riskReward < 1.1) return "中高";
  if (signal.score >= 75 && signal.riskReward >= 1.5) return "中";
  return "中";
}

function buildRiskNotes(signal, snapshot) {
  const notes = [];
  if (signal.marketType === "futures") notes.push("合约信号存在强平、资金费率和滑点风险，不建议高杠杆。");
  if (snapshot.fusion?.status === "partial") notes.push("合约衍生指标部分缺失，已降低融合评分。");
  if (snapshot.fusion?.status === "unavailable") notes.push("合约持仓、资金费率或多空人数比不可用，信号只能作为观察。");
  if ((snapshot.volatilityPercent || 0) >= 5) notes.push("当前波动率较高，入场区间和止损可能被快速扫过。");
  if (signal.riskReward !== null && signal.riskReward < 1.2) notes.push("TP1 的盈亏比偏低，更适合等待更好的价格。");
  if ((snapshot.spreadPercent || 0) > 0.2) notes.push("买卖价差偏大，成交滑点风险较高。");
  if (snapshot.directionAnalysis?.dataQuality?.status === "partial") notes.push("实时方向数据部分缺失，已降低方向评分权重。");
  return notes.length ? notes : ["风险可控性取决于是否严格执行止损和仓位限制。"];
}
