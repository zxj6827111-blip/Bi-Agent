import { atr, closedCandles, macd, rsi, sma, volumeRatio } from "./indicators.js";
import { clamp, round } from "./utils.js";

const MIN_CANDLES = 35;
const LOOKBACK = 80;

export function buildSwingAnalysis({ market, candlesByInterval = {}, snapshots = [] }) {
  const interval = chooseInterval(candlesByInterval);
  const candles = closedCandles(interval ? candlesByInterval[interval] : []);
  if (!candles || candles.length < MIN_CANDLES) {
    return emptySwing("波段数据不足，继续等待更多分时K线。");
  }

  const slice = candles.slice(-LOOKBACK);
  const latest = slice.at(-1);
  const previous = slice.at(-2) || latest;
  const closes = candles.map((candle) => candle.close);
  const price = latest.close;
  const swingHigh = Math.max(...slice.map((candle) => candle.high));
  const swingLow = Math.min(...slice.map((candle) => candle.low));
  const swingRange = Math.max(swingHigh - swingLow, price * 0.000001);
  const rangePosition = clamp((price - swingLow) / swingRange, 0, 1);
  const atrValue = atr(candles) || swingRange / 12;
  const atrPercent = price ? (atrValue / price) * 100 : 0;
  const rangePercent = price ? (swingRange / price) * 100 : 0;
  const rsiValue = rsi(closes);
  const macdValue = macd(closes);
  const volume = volumeRatio(candles) || 0;
  const trend = inferSwingTrend({ snapshots, closes });
  const volatilityLevel = classifyVolatility({ atrPercent, rangePercent });
  const lastRange = Math.max(latest.high - latest.low, price * 0.000001);
  const lowerWickRatio = (Math.min(latest.open, latest.close) - latest.low) / lastRange;
  const upperWickRatio = (latest.high - Math.max(latest.open, latest.close)) / lastRange;
  const momentum3 = percentChange(price, candles.at(-4)?.close ?? previous.close);
  const candleChange = percentChange(price, previous.close);
  const volumeState = classifyVolume(volume);
  const lowZone = [swingLow, swingLow + swingRange * 0.24].map((value) => round(value));
  const highZone = [swingHigh - swingRange * 0.24, swingHigh].map((value) => round(value));
  const trendSide = trendSideOf(trend);

  const bottom = buildBottomSignal({
    interval,
    trend,
    trendSide,
    price,
    lowZone,
    rangePosition,
    volatilityLevel,
    rsiValue,
    volume,
    volumeState,
    lowerWickRatio,
    momentum3,
    candleChange
  });

  const top = buildTopSignal({
    interval,
    trend,
    trendSide,
    price,
    highZone,
    rangePosition,
    volatilityLevel,
    rsiValue,
    volume,
    volumeState,
    upperWickRatio,
    momentum3,
    candleChange
  });

  return {
    mode: "swing",
    symbol: market?.symbol,
    interval,
    price: round(price),
    trend,
    trendLabel: trendLabel(trend),
    trendSide,
    volatilityLevel,
    volatilityLabel: volatilityLabel(volatilityLevel),
    rangePercent: round(rangePercent, 2),
    atrPercent: round(atrPercent, 2),
    rangePosition: round(rangePosition * 100, 1),
    volumeRatio: round(volume, 2),
    volumeState,
    swingHigh: round(swingHigh),
    swingLow: round(swingLow),
    lowZone,
    highZone,
    rsi: round(rsiValue, 2),
    macdHistogram: round(macdValue.histogram, 8),
    bottom,
    top,
    action: chooseSwingAction({ bottom, top, trendSide }),
    summary: buildSummary({ bottom, top, trend, volatilityLevel, rangePosition, volumeState })
  };
}

function emptySwing(reason) {
  return {
    mode: "swing",
    action: "wait",
    trend: "unknown",
    trendLabel: "未知",
    trendSide: "neutral",
    volatilityLevel: "unknown",
    volatilityLabel: "未知",
    rangePercent: null,
    atrPercent: null,
    rangePosition: null,
    volumeRatio: null,
    volumeState: "未知",
    lowZone: null,
    highZone: null,
    bottom: emptyLeg("low", reason),
    top: emptyLeg("high", reason),
    summary: reason
  };
}

function emptyLeg(zone, reason) {
  return {
    zone,
    action: "wait",
    label: zone === "low" ? "低点等待" : "高点等待",
    score: 0,
    zoneRange: null,
    confirmed: false,
    reasons: [reason],
    risks: ["波段提示只能作为观察信号，不能保证买在最低或卖在最高。"]
  };
}

function chooseInterval(candlesByInterval) {
  if ((candlesByInterval["1m"] || []).length >= MIN_CANDLES) return "1m";
  if ((candlesByInterval["5m"] || []).length >= MIN_CANDLES) return "5m";
  if ((candlesByInterval["15m"] || []).length >= MIN_CANDLES) return "15m";
  return null;
}

function buildBottomSignal(input) {
  const nearLow = input.rangePosition <= 0.28;
  const watchLow = input.rangePosition <= 0.4;
  const volumeConfirm = input.volume >= 1.25;
  const wickConfirm = input.lowerWickRatio >= 0.35;
  const rsiConfirm = Number(input.rsiValue) <= 42;
  const momentumConfirm = input.momentum3 > 0 || input.candleChange > 0.35;
  let score = 30;

  if (nearLow) score += 25;
  else if (watchLow) score += 14;
  if (input.volatilityLevel === "high") score += 10;
  if (volumeConfirm) score += 12;
  if (wickConfirm) score += 10;
  if (rsiConfirm) score += 8;
  if (momentumConfirm) score += 8;
  if (input.trendSide === "long") score += 5;
  if (input.trendSide === "short") score -= 4;
  score = clamp(Math.round(score), 0, 100);

  const confirmed = nearLow && score >= 72 && (volumeConfirm || wickConfirm || momentumConfirm);
  const label = confirmed
    ? input.trendSide === "short"
      ? "低点反弹买入确认"
      : "低点买入确认"
    : watchLow
      ? input.trendSide === "short"
        ? "低点反弹观察"
        : "低点观察"
      : "低点等待";

  return {
    zone: "low",
    action: confirmed ? "buy_confirm" : watchLow ? "low_watch" : "wait",
    label,
    score,
    zoneRange: input.lowZone,
    confirmed,
    reasons: [
      watchLow ? `价格处在近期波段低位 ${Math.round(input.rangePosition * 100)}%` : "价格尚未靠近近期低位。",
      input.volatilityLevel === "high" ? "当前属于高波动，适合重点观察波段。": "波动未达到强波段级别。",
      volumeConfirm ? `成交量放大 ${round(input.volume, 2)} 倍。` : `成交量 ${input.volumeState}，需要继续确认。`,
      wickConfirm ? "低位出现下影线，说明有承接迹象。" : "暂未看到明显低位承接。",
      momentumConfirm ? "短线动能开始修复。" : "短线动能尚未确认反转。"
    ],
    risks: [
      input.trendSide === "short" ? "下跌趋势里的低点买入属于反弹交易，必须小仓位并设置止损。" : "低点确认也可能是假反弹，需要等待下一根K线验证。",
      "不能保证买在最低点，提示含义是进入低位观察或确认区。"
    ]
  };
}

function buildTopSignal(input) {
  const nearHigh = input.rangePosition >= 0.72;
  const watchHigh = input.rangePosition >= 0.6;
  const volumeConfirm = input.volume >= 1.25;
  const wickConfirm = input.upperWickRatio >= 0.35;
  const rsiConfirm = Number(input.rsiValue) >= 62;
  const momentumConfirm = input.momentum3 < 0 || input.candleChange < -0.35;
  let score = 30;

  if (nearHigh) score += 25;
  else if (watchHigh) score += 14;
  if (input.volatilityLevel === "high") score += 10;
  if (volumeConfirm) score += 12;
  if (wickConfirm) score += 10;
  if (rsiConfirm) score += 7;
  if (momentumConfirm) score += 8;
  if (input.trendSide === "short") score += 6;
  if (input.trendSide === "long") score -= 2;
  score = clamp(Math.round(score), 0, 100);

  const confirmed = nearHigh && score >= 72 && (volumeConfirm || wickConfirm || momentumConfirm);
  const label = confirmed
    ? input.trendSide === "short"
      ? "高点开空确认"
      : "高点卖出确认"
    : watchHigh
      ? input.trendSide === "short"
        ? "反弹高点观察"
        : "高点观察"
      : "高点等待";

  return {
    zone: "high",
    action: confirmed ? (input.trendSide === "short" ? "short_confirm" : "sell_confirm") : watchHigh ? "high_watch" : "wait",
    label,
    score,
    zoneRange: input.highZone,
    confirmed,
    reasons: [
      watchHigh ? `价格处在近期波段高位 ${Math.round(input.rangePosition * 100)}%` : "价格尚未靠近近期高位。",
      input.volatilityLevel === "high" ? "当前属于高波动，高位回落风险更需要监控。" : "波动未达到强波段级别。",
      volumeConfirm ? `成交量放大 ${round(input.volume, 2)} 倍。` : `成交量 ${input.volumeState}，需要继续确认。`,
      wickConfirm ? "高位出现上影线，说明有抛压迹象。" : "暂未看到明显高位抛压。",
      momentumConfirm ? "短线动能开始转弱。" : "短线动能尚未确认转弱。"
    ],
    risks: [
      input.trendSide === "long" ? "上涨趋势里的高点卖出可能卖飞，适合分批止盈。" : "下跌趋势反弹高点做空仍需确认盘口和止损。",
      "不能保证卖在最高点，提示含义是进入高位观察或确认区。"
    ]
  };
}

function chooseSwingAction({ bottom, top, trendSide }) {
  if (top.confirmed && trendSide === "short") return "short_confirm";
  if (bottom.confirmed && trendSide !== "short") return "buy_confirm";
  if (top.confirmed) return "sell_confirm";
  if (bottom.confirmed) return "buy_confirm";
  if (top.action === "high_watch") return "high_watch";
  if (bottom.action === "low_watch") return "low_watch";
  return "wait";
}

function buildSummary({ bottom, top, trend, volatilityLevel, rangePosition, volumeState }) {
  const positionText = rangePosition <= 0.35
    ? "靠近低位"
    : rangePosition >= 0.65
      ? "靠近高位"
      : "处在区间中部";
  const main = [bottom, top].sort((a, b) => b.score - a.score)[0];
  return `${trendLabel(trend)}趋势，${volatilityLabel(volatilityLevel)}波动，价格${positionText}；当前波段侧重点：${main.label}，成交量${volumeState}。`;
}

function inferSwingTrend({ snapshots, closes }) {
  const higher = snapshots.find((snapshot) => snapshot.interval === "15m")
    || snapshots.find((snapshot) => snapshot.interval === "5m")
    || snapshots[0];
  if (higher?.trend) return higher.trend;

  const fast = sma(closes, 10);
  const slow = sma(closes, 30);
  if (!fast || !slow) return "unknown";
  if (fast > slow) return "up";
  if (fast < slow) return "down";
  return "range";
}

function classifyVolatility({ atrPercent, rangePercent }) {
  if (rangePercent >= 8 || atrPercent >= 1.2) return "high";
  if (rangePercent >= 3.5 || atrPercent >= 0.45) return "medium";
  return "low";
}

function classifyVolume(value) {
  if (value >= 1.5) return "明显放量";
  if (value >= 1.1) return "温和放量";
  if (value > 0 && value <= 0.65) return "缩量";
  return "正常";
}

function trendSideOf(trend) {
  if (trend === "up" || trend === "recovering") return "long";
  if (trend === "down" || trend === "weakening") return "short";
  return "neutral";
}

function trendLabel(trend) {
  if (trend === "up") return "上涨";
  if (trend === "recovering") return "修复";
  if (trend === "down") return "下跌";
  if (trend === "weakening") return "转弱";
  if (trend === "range") return "震荡";
  return "未知";
}

function volatilityLabel(level) {
  if (level === "high") return "高";
  if (level === "medium") return "中";
  if (level === "low") return "低";
  return "未知";
}

function percentChange(current, previous) {
  if (!Number.isFinite(Number(current)) || !Number.isFinite(Number(previous)) || Number(previous) === 0) return 0;
  return ((Number(current) - Number(previous)) / Number(previous)) * 100;
}
