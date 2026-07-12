import { BinanceClient } from "../src/binanceClient.js";
import { config } from "../src/config.js";
import { buildMarketSnapshot, generateSignalsFromSnapshot, screenSignalsForQuality } from "../src/signalEngine.js";
import { evaluateFromCandles } from "../src/signalEvaluator.js";
import { summarizeEvaluationSet } from "../src/strategyValidation.js";

const DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];
const HORIZONS = [4, 24];
const LOOKBACK = 120;
const REPLAY_DAYS = Number(process.env.REPLAY_DAYS || 60);
const STEP_CANDLES = Number(process.env.REPLAY_STEP_CANDLES || 4);
const MAX_SIGNALS_PER_TIMESTAMP = Number(process.env.REPLAY_MAX_SIGNALS_PER_TIMESTAMP || 3);

const client = new BinanceClient(config.binance);
const symbols = normalizeSymbols(process.argv.slice(2));

const catalog = await loadSpotCatalog();
const reports = [];
for (const symbol of symbols) {
  reports.push(await replaySymbol(symbol));
}

const allEvaluations = reports.flatMap((report) => report.evaluations);
const combined = summarizeEvaluationSet(allEvaluations);

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  symbols,
  note: "本回放使用历史现货K线、当前规则和成本模型进行纸面评估。",
  settings: {
    horizons: HORIZONS,
    replayDays: REPLAY_DAYS,
    lookback: LOOKBACK,
    stepCandles: STEP_CANDLES,
    maxSignalsPerTimestamp: MAX_SIGNALS_PER_TIMESTAMP,
    tradingCosts: config.tradingCosts,
    validation: config.validation
  },
  combined,
  reports: reports.map(({ evaluations, ...report }) => ({
    ...report,
    evaluations: evaluations.slice(0, 20)
  }))
}, null, 2));

function normalizeSymbols(args) {
  const raw = args.length ? args : DEFAULT_SYMBOLS;
  return [...new Set(raw
    .flatMap((value) => String(value).split(/[\s,，;；|]+/))
    .map((value) => value.toUpperCase().replace(/[-_/]/g, "").trim())
    .filter(Boolean)
    .map((value) => value.endsWith("USDT") ? value : `${value}USDT`))];
}

async function loadSpotCatalog() {
  try {
    const markets = await client.getSpotSymbols();
    return new Map(markets.map((market) => [market.symbol, market]));
  } catch (error) {
    return new Map();
  }
}

async function replaySymbol(symbol) {
  const [candles15m, candles1h, candles4h] = await Promise.all([
    fetchKlinesRange(symbol, "15m", REPLAY_DAYS),
    fetchKlinesRange(symbol, "1h", REPLAY_DAYS + 25),
    fetchKlinesRange(symbol, "4h", REPLAY_DAYS + 30)
  ]);

  const evaluations = [];
  const scanStats = {
    timestamps: 0,
    rawSignals: 0,
    actionableSignals: 0
  };
  const maxHorizonCandles = Math.max(...HORIZONS) * 4;
  const startIndex = Math.max(LOOKBACK, maxHorizonCandles);
  const endIndex = candles15m.length - maxHorizonCandles - 1;

  for (let index = startIndex; index <= endIndex; index += Math.max(1, STEP_CANDLES)) {
    const currentTime = candles15m[index].closeTime;
    const market = marketAt(symbol, candles15m, index);
    const windows = {
      "15m": candles15m.slice(index - LOOKBACK + 1, index + 1),
      "1h": candlesUpTo(candles1h, currentTime).slice(-LOOKBACK),
      "4h": candlesUpTo(candles4h, currentTime).slice(-LOOKBACK)
    };
    if (Object.values(windows).some((items) => items.length < LOOKBACK)) continue;

    const snapshots = Object.entries(windows)
      .map(([interval, candles]) => buildMarketSnapshot({ market, interval, candles }));
    const rawSignals = snapshots.flatMap(generateSignalsFromSnapshot);
    const signals = screenSignalsForQuality(rawSignals, snapshots, MAX_SIGNALS_PER_TIMESTAMP);
    scanStats.timestamps += 1;
    scanStats.rawSignals += rawSignals.length;
    scanStats.actionableSignals += signals.length;

    for (const signal of signals) {
      for (const horizonHours of HORIZONS) {
        const horizonCandles = horizonHours * 4;
        const futureCandles = candles15m.slice(index + 1, index + 1 + horizonCandles);
        if (futureCandles.length < horizonCandles) continue;
        evaluations.push(evaluateFromCandles({
          id: `${symbol}:${currentTime}:${signal.id}:${horizonHours}h`,
          session: {
            id: `replay:${symbol}:${currentTime}`,
            startTime: new Date(currentTime).toISOString(),
            endTime: new Date(currentTime).toISOString()
          },
          signal,
          horizonHours,
          candles: futureCandles
        }));
      }
    }
  }

  return {
    symbol,
    candles: {
      "15m": candles15m.length,
      "1h": candles1h.length,
      "4h": candles4h.length
    },
    scanStats,
    summary: summarizeEvaluationSet(evaluations),
    evaluations
  };
}

async function fetchKlinesRange(symbol, interval, days) {
  const intervalMs = intervalToMs(interval);
  const endTime = Date.now() - intervalMs;
  const startTime = endTime - days * 24 * 60 * 60 * 1000;
  const rows = [];
  const seen = new Set();
  let cursor = startTime;

  while (cursor < endTime) {
    const batch = await client.getKlines("spot", symbol, interval, 1000, {
      startTime: cursor,
      endTime
    });
    if (!batch.length) break;

    for (const candle of batch) {
      if (candle.closeTime > endTime || seen.has(candle.closeTime)) continue;
      seen.add(candle.closeTime);
      rows.push(candle);
    }

    const nextCursor = batch.at(-1).closeTime + 1;
    if (nextCursor <= cursor || batch.length < 1000) break;
    cursor = nextCursor;
  }

  return rows.sort((a, b) => a.closeTime - b.closeTime);
}

function intervalToMs(interval) {
  if (interval === "15m") return 15 * 60 * 1000;
  if (interval === "1h") return 60 * 60 * 1000;
  if (interval === "4h") return 4 * 60 * 60 * 1000;
  throw new Error(`Unsupported replay interval: ${interval}`);
}

function marketAt(symbol, candles15m, index) {
  const current = candles15m[index];
  const previous24h = candles15m[Math.max(0, index - 96)];
  const catalogMarket = catalog.get(symbol) || {};
  return {
    symbol,
    baseAsset: symbol.replace(/USDT$/, ""),
    quoteAsset: "USDT",
    marketType: "spot",
    lastPrice: current.close,
    priceChangePercent: previous24h?.close ? ((current.close - previous24h.close) / previous24h.close) * 100 : 0,
    quoteVolume: catalogMarket.quoteVolume || current.quoteVolume || 100_000_000,
    bidPrice: catalogMarket.bidPrice || current.close,
    askPrice: catalogMarket.askPrice || current.close,
    spreadPercent: Number.isFinite(catalogMarket.spreadPercent) ? catalogMarket.spreadPercent : 0.03,
    fundingRate: null
  };
}

function candlesUpTo(candles, time) {
  return candles.filter((candle) => candle.closeTime <= time);
}
