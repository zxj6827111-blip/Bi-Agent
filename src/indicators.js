import { mean, round } from "./utils.js";

export function sma(values, period) {
  if (values.length < period) return null;
  return mean(values.slice(-period));
}

export function emaSeries(values, period) {
  if (values.length < period) return [];
  const multiplier = 2 / (period + 1);
  const output = [];
  let previous = mean(values.slice(0, period));
  output.push(previous);

  for (let i = period; i < values.length; i += 1) {
    previous = values[i] * multiplier + previous * (1 - multiplier);
    output.push(previous);
  }

  return output;
}

export function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  if (values.length < slow + signal) {
    return { macd: null, signal: null, histogram: null };
  }

  const fastSeries = emaSeries(values, fast);
  const slowSeries = emaSeries(values, slow);
  const offset = fastSeries.length - slowSeries.length;
  const macdLine = slowSeries.map((slowValue, index) => fastSeries[index + offset] - slowValue);
  const signalSeries = emaSeries(macdLine, signal);
  if (!signalSeries.length) return { macd: null, signal: null, histogram: null };

  const latestMacd = macdLine[macdLine.length - 1];
  const latestSignal = signalSeries[signalSeries.length - 1];
  return {
    macd: latestMacd,
    signal: latestSignal,
    histogram: latestMacd - latestSignal
  };
}

export function atr(candles, period = 14) {
  if (candles.length <= period) return null;
  const ranges = [];

  for (let i = 1; i < candles.length; i += 1) {
    const current = candles[i];
    const previous = candles[i - 1];
    ranges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      )
    );
  }

  return mean(ranges.slice(-period));
}

export function bollingerBands(values, period = 20, multiplier = 2) {
  if (values.length < period) return {
    middle: null,
    upper: null,
    lower: null,
    bandwidthPercent: null,
    percentB: null
  };

  const slice = values.slice(-period);
  const middle = mean(slice);
  const variance = mean(slice.map((value) => (value - middle) ** 2));
  const deviation = Math.sqrt(variance || 0);
  const upper = middle + deviation * multiplier;
  const lower = middle - deviation * multiplier;
  const latest = values[values.length - 1];
  const width = upper - lower;

  return {
    middle,
    upper,
    lower,
    bandwidthPercent: middle ? (width / middle) * 100 : null,
    percentB: width ? (latest - lower) / width : null
  };
}

export function slopePercent(values, period = 8) {
  if (values.length <= period) return null;
  const latest = values[values.length - 1];
  const previous = values[values.length - 1 - period];
  if (!previous) return null;
  return ((latest - previous) / previous) * 100;
}

export function summarizeIndicatorState({ closes, candles, macdValue, rsiValue, bollinger, atrValue }) {
  const latest = closes.at(-1);
  const previous = closes.at(-2) ?? latest;
  const volume = volumeRatio(candles) || 1;
  const atrPercent = atrValue && latest ? (atrValue / latest) * 100 : null;
  const macdTrend = macdValue.histogram > 0
    ? "bullish"
    : macdValue.histogram < 0
      ? "bearish"
      : "neutral";
  const rsiState = rsiValue >= 70
    ? "overbought"
    : rsiValue <= 30
      ? "oversold"
      : rsiValue >= 52
        ? "bullish"
        : rsiValue <= 48
          ? "bearish"
          : "neutral";
  const bollingerState = inferBollingerState(latest, previous, bollinger, volume);
  const trendSlopePercent = slopePercent(closes, 8);
  const breakoutBias = inferBreakoutBias({ latest, previous, bollinger, volume, macdTrend, rsiState });

  return {
    macdTrend,
    rsiState,
    bollingerState,
    breakoutBias,
    trendSlopePercent: round(trendSlopePercent, 3),
    volumeExpansion: round(volume, 2),
    atrPercent: round(atrPercent, 3)
  };
}

function inferBollingerState(latest, previous, bollinger, volume) {
  if (!Number.isFinite(latest) || !Number.isFinite(bollinger?.upper) || !Number.isFinite(bollinger?.lower)) return "unknown";
  if (latest > bollinger.upper) return volume >= 1.35 ? "upper_breakout" : "upper_probe";
  if (latest < bollinger.lower) return volume >= 1.35 ? "lower_breakdown" : "lower_probe";
  if (previous > bollinger.upper && latest <= bollinger.upper) return "upper_rejection";
  if (previous < bollinger.lower && latest >= bollinger.lower) return "lower_reclaim";
  if (bollinger.percentB >= 0.75) return "upper_half";
  if (bollinger.percentB <= 0.25) return "lower_half";
  return "mid_range";
}

function inferBreakoutBias({ latest, previous, bollinger, volume, macdTrend, rsiState }) {
  if (!Number.isFinite(latest) || !Number.isFinite(bollinger?.upper) || !Number.isFinite(bollinger?.lower)) return "neutral";
  const bullishBreakout = latest > bollinger.upper && volume >= 1.35 && macdTrend === "bullish" && rsiState !== "overbought";
  const bearishBreakdown = latest < bollinger.lower && volume >= 1.35 && macdTrend === "bearish" && rsiState !== "oversold";
  if (bullishBreakout) return "bullish_breakout";
  if (bearishBreakdown) return "bearish_breakdown";
  if (latest > bollinger.upper && volume < 1.2) return "bullish_fakeout_risk";
  if (latest < bollinger.lower && volume < 1.2) return "bearish_fakeout_risk";
  if (previous > bollinger.upper && latest <= bollinger.upper) return "bullish_rejection";
  if (previous < bollinger.lower && latest >= bollinger.lower) return "bearish_reclaim";
  return "neutral";
}

export function supportResistance(candles, lookback = 50) {
  const slice = candles.slice(-lookback);
  if (!slice.length) return { support: null, resistance: null };

  return {
    support: Math.min(...slice.map((candle) => candle.low)),
    resistance: Math.max(...slice.map((candle) => candle.high))
  };
}

export function closedCandles(candles, nowMs = Date.now()) {
  if (!Array.isArray(candles)) return [];
  return candles.filter((candle) => !isUnclosedCandle(candle, nowMs));
}

export function isUnclosedCandle(candle, nowMs = Date.now()) {
  const closeTime = Number(candle?.closeTime);
  return Number.isFinite(closeTime) && closeTime > nowMs;
}

export function volumeRatio(candles, period = 20) {
  if (candles.length < period + 1) return null;
  const previous = candles.slice(-(period + 1), -1).map((candle) => candle.volume);
  const base = mean(previous);
  if (!base) return null;
  return candles[candles.length - 1].volume / base;
}

export function normalizeKlines(rows) {
  return rows.map((row) => ({
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
    quoteVolume: Number(row[7])
  }));
}
