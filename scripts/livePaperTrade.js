import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BinanceClient } from "../src/binanceClient.js";
import { config } from "../src/config.js";
import { buildMarketRegime, enrichMarketWithDirection } from "../src/directionEngine.js";
import { buildMarketSnapshot, filterTradableSymbols } from "../src/signalEngine.js";
import { withMarketSource } from "../src/marketFusion.js";
import { clamp, mapWithConcurrency, round, sleep } from "../src/utils.js";

const client = new BinanceClient(config.binance);

const options = {
  symbolLimit: readInt("PAPER_SYMBOL_LIMIT", 24),
  positions: readInt("PAPER_POSITIONS", 4),
  interval: process.env.PAPER_INTERVAL || "1m",
  klineLimit: readInt("PAPER_KLINE_LIMIT", 120),
  monitorSeconds: readInt("PAPER_MONITOR_SECONDS", 480),
  pollSeconds: readInt("PAPER_POLL_SECONDS", 10),
  minTargetPercent: readNumber("PAPER_MIN_TARGET_PERCENT", 0.18),
  maxTargetPercent: readNumber("PAPER_MAX_TARGET_PERCENT", 0.35),
  minStopPercent: readNumber("PAPER_MIN_STOP_PERCENT", 0.12),
  maxStopPercent: readNumber("PAPER_MAX_STOP_PERCENT", 0.25),
  minVolumeRatio: readNumber("PAPER_MIN_VOLUME_RATIO", 0.1),
  targetAtrFraction: readNumber("PAPER_TARGET_ATR_FRACTION", 0.3),
  stopAtrFraction: readNumber("PAPER_STOP_ATR_FRACTION", 0.22),
  requestConcurrency: readInt("PAPER_REQUEST_CONCURRENCY", 4),
  forced: readBoolean("PAPER_FORCE_SIGNAL", true)
};

const startedAt = new Date().toISOString();
console.log(`[paper] start ${startedAt}`);
console.log(`[paper] options ${JSON.stringify(options)}`);

const session = await runPaperSession();
console.log(JSON.stringify(session, null, 2));

async function runPaperSession() {
  const setup = await buildPaperSetups();
  const opened = setup.candidates.slice(0, options.positions).map(openPosition);
  console.log(`[paper] opened ${opened.length} proxy futures positions`);
  for (const position of opened) {
    console.log(`[paper] ${position.side.toUpperCase()} ${position.symbol} entry=${position.entryPrice} tp=${position.takeProfit} stop=${position.stopLoss} score=${position.score}`);
  }

  const closed = await monitorPositions(opened);
  const summary = summarizeClosedTrades(closed);
  const finishedAt = new Date().toISOString();
  const session = {
    mode: "spot_price_as_futures_proxy_paper_trade",
    startedAt,
    finishedAt,
    options,
    marketRegime: setup.regime,
    universe: {
      eligibleSpotMarkets: setup.eligibleSpotMarkets,
      analyzedMarkets: setup.analyzedMarkets,
      candidateCount: setup.candidates.length
    },
    summary,
    trades: closed
  };

  const outputDir = join(process.cwd(), "data", "live-paper-trades");
  mkdirSync(outputDir, { recursive: true });
  const fileName = `${startedAt.replace(/[:.]/g, "-")}.json`;
  const outputPath = join(outputDir, fileName);
  session.outputPath = outputPath;
  writeFileSync(outputPath, JSON.stringify(session, null, 2), "utf8");
  return session;
}

async function buildPaperSetups() {
  const spotRaw = await client.getSpotSymbols();
  const spotUniverse = filterTradableSymbols(spotRaw, config.scan).map((market) => withMarketSource(market, "spot"));
  const selected = spotUniverse.slice(0, options.symbolLimit);
  const regime = buildMarketRegime({ spotMarkets: spotUniverse, preferredMarketType: "spot" });

  const candidates = await mapWithConcurrency(selected, options.requestConcurrency, async (market) => {
    try {
      const [microstructure, candles] = await Promise.all([
        client.getMarketMicrostructure("spot", market.symbol, {
          depthLimit: config.direction.depthLimit,
          aggTradeLimit: config.direction.aggTradeLimit
        }),
        client.getKlines("spot", market.symbol, options.interval, options.klineLimit)
      ]);
      const enriched = enrichMarketWithDirection({ market, microstructure, regime });
      const snapshot = buildMarketSnapshot({ market: enriched, interval: options.interval, candles });
      return buildCandidate(snapshot, microstructure);
    } catch (error) {
      return {
        symbol: market.symbol,
        rejected: true,
        reason: error.message
      };
    }
  });

  const usable = candidates
    .filter((candidate) => candidate && !candidate.rejected)
    .filter((candidate) => Number(candidate.volumeRatio || 0) >= options.minVolumeRatio)
    .filter((candidate) => options.forced || candidate.directionEdgeAbs >= config.direction.minFormalEdge)
    .sort((a, b) => b.score - a.score);

  if (!usable.length) {
    throw new Error(`No paper candidates were available after volume filter PAPER_MIN_VOLUME_RATIO=${options.minVolumeRatio}.`);
  }

  return {
    regime,
    eligibleSpotMarkets: spotUniverse.length,
    analyzedMarkets: selected.length,
    candidates: usable
  };
}

function buildCandidate(snapshot, microstructure) {
  const direction = snapshot.directionAnalysis || {};
  const edge = Number(direction.edgeScore || 0);
  const longScore = scoreSide(snapshot, edge, "long");
  const shortScore = scoreSide(snapshot, edge, "short");
  const side = longScore >= shortScore ? "long" : "short";
  const score = Math.max(longScore, shortScore);
  const orderBook = microstructure?.orderBook || {};
  const executableEntry = executablePrice(orderBook, side, "open") || snapshot.price;
  const atrPercent = snapshot.indicators.atr && executableEntry
    ? (snapshot.indicators.atr / executableEntry) * 100
    : 0.18;
  const targetPercent = clamp(
    Math.max(options.minTargetPercent, atrPercent * options.targetAtrFraction),
    options.minTargetPercent,
    options.maxTargetPercent
  );
  const stopPercent = clamp(
    Math.max(options.minStopPercent, atrPercent * options.stopAtrFraction),
    options.minStopPercent,
    options.maxStopPercent
  );

  return {
    symbol: snapshot.symbol,
    side,
    score,
    directionEdge: edge,
    directionEdgeAbs: Math.abs(edge),
    direction: direction.direction,
    probabilityUp: direction.probabilityUp,
    probabilityDown: direction.probabilityDown,
    evidence: direction.evidence || [],
    trend: snapshot.trend,
    rsi: snapshot.indicators.rsi,
    macdHistogram: snapshot.indicators.macdHistogram,
    volumeRatio: snapshot.indicators.volumeRatio,
    atrPercent: round(atrPercent, 4),
    candleWindow: snapshot.candleWindow,
    entryPrice: round(executableEntry, 10),
    takeProfit: round(applyMove(executableEntry, side, targetPercent), 10),
    stopLoss: round(applyMove(executableEntry, side, -stopPercent), 10),
    targetPercent: round(targetPercent, 4),
    stopPercent: round(stopPercent, 4),
    dataSource: "spot_as_futures_proxy",
    forced: Math.abs(edge) < config.direction.minFormalEdge,
    snapshot: {
      price: snapshot.price,
      interval: snapshot.interval,
      priceChangePercent24h: snapshot.priceChangePercent24h,
      technicalConsensus: snapshot.technicalConsensus,
      indicatorState: snapshot.indicatorState,
      supportResistance: snapshot.supportResistance
    }
  };
}

function scoreSide(snapshot, edge, side) {
  const rsi = Number(snapshot.indicators.rsi || 50);
  const histogram = Number(snapshot.indicators.macdHistogram || 0);
  const volume = Number(snapshot.indicators.volumeRatio || 1);
  const edgeAligned = side === "long" ? edge : -edge;
  let score = 50 + edgeAligned * 0.55;

  if (side === "long") {
    if (snapshot.trend === "up") score += 12;
    if (snapshot.trend === "recovering") score += 8;
    if (histogram > 0) score += 7;
    if (rsi >= 45 && rsi <= 68) score += 6;
    if (snapshot.technicalConsensus?.long?.allowed) score += 8;
    if (snapshot.indicatorState?.breakoutBias === "bullish_fakeout_risk") score -= 8;
  } else {
    if (snapshot.trend === "down") score += 12;
    if (snapshot.trend === "weakening") score += 8;
    if (histogram < 0) score += 7;
    if (rsi >= 32 && rsi <= 58) score += 5;
    if (snapshot.technicalConsensus?.short?.allowed) score += 8;
    if (snapshot.indicatorState?.breakoutBias === "bearish_fakeout_risk") score -= 8;
  }

  if (volume >= 1.2) score += 4;
  if (volume >= 1.6) score += 3;
  if (volume < 0.35) score -= 5;
  if (volume < 0.15) score -= 6;
  if (Number(snapshot.spreadPercent || 0) > 0.15) score -= 8;
  return clamp(Math.round(score), 0, 100);
}

function openPosition(candidate) {
  return {
    ...candidate,
    openedAt: new Date().toISOString(),
    status: "open",
    bestPrice: candidate.entryPrice,
    worstPrice: candidate.entryPrice,
    polls: []
  };
}

async function monitorPositions(positions) {
  const deadline = Date.now() + options.monitorSeconds * 1000;
  let open = positions;
  let closed = [];

  while (open.length && Date.now() < deadline) {
    await sleep(options.pollSeconds * 1000);
    const checked = await mapWithConcurrency(open, options.requestConcurrency, checkPosition);
    closed.push(...checked.filter((item) => item.status === "closed"));
    open = checked.filter((item) => item.status === "open");
    const statusLine = checked
      .map((item) => `${item.symbol}:${item.status === "closed" ? item.outcome : round(item.unrealizedGrossReturnPercent, 3) + "%"}`)
      .join(" ");
    console.log(`[paper] ${new Date().toISOString()} ${statusLine}`);
  }

  if (open.length) {
    const timeoutClosed = await mapWithConcurrency(open, options.requestConcurrency, closeByTimeout);
    closed.push(...timeoutClosed);
  }

  return closed.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

async function checkPosition(position) {
  const book = await client.getOrderBookDepth("spot", position.symbol, 5);
  const executableExit = executablePrice(book, position.side, "close") || position.entryPrice;
  const gross = grossReturnPercent(position.side, position.entryPrice, executableExit);
  const next = updatePathStats(position, executableExit, gross, book);

  if (position.side === "long") {
    if (executableExit >= position.takeProfit) return closePosition(next, "tp", executableExit);
    if (executableExit <= position.stopLoss) return closePosition(next, "stop", executableExit);
  } else {
    if (executableExit <= position.takeProfit) return closePosition(next, "tp", executableExit);
    if (executableExit >= position.stopLoss) return closePosition(next, "stop", executableExit);
  }

  return {
    ...next,
    unrealizedGrossReturnPercent: round(gross, 4)
  };
}

async function closeByTimeout(position) {
  const book = await client.getOrderBookDepth("spot", position.symbol, 5);
  const executableExit = executablePrice(book, position.side, "close") || position.entryPrice;
  const gross = grossReturnPercent(position.side, position.entryPrice, executableExit);
  return closePosition(updatePathStats(position, executableExit, gross, book), "timeout", executableExit);
}

function updatePathStats(position, price, gross, book) {
  const bestPrice = position.side === "long"
    ? Math.max(position.bestPrice, price)
    : Math.min(position.bestPrice, price);
  const worstPrice = position.side === "long"
    ? Math.min(position.worstPrice, price)
    : Math.max(position.worstPrice, price);
  return {
    ...position,
    bestPrice: round(bestPrice, 10),
    worstPrice: round(worstPrice, 10),
    polls: [
      ...position.polls,
      {
        at: new Date().toISOString(),
        price: round(price, 10),
        grossReturnPercent: round(gross, 4),
        bestBid: round(book.bestBid, 10),
        bestAsk: round(book.bestAsk, 10)
      }
    ].slice(-100)
  };
}

function closePosition(position, outcome, exitPrice) {
  const gross = grossReturnPercent(position.side, position.entryPrice, exitPrice);
  const roundTripFeePercent = Number(config.tradingCosts.futuresFeeRate || 0) * 2 * 100;
  const estimatedSlippagePercent = Number(config.tradingCosts.slippagePercent || 0) * 2;
  const estimatedNet = gross - roundTripFeePercent - estimatedSlippagePercent;
  const closedAt = new Date().toISOString();

  return {
    ...position,
    status: "closed",
    outcome,
    closedAt,
    secondsHeld: Math.round((Date.parse(closedAt) - Date.parse(position.openedAt)) / 1000),
    exitPrice: round(exitPrice, 10),
    grossReturnPercent: round(gross, 4),
    feePercent: round(roundTripFeePercent, 4),
    slippagePercent: round(estimatedSlippagePercent, 4),
    estimatedNetReturnPercent: round(estimatedNet, 4),
    netWin: estimatedNet > 0
  };
}

function summarizeClosedTrades(trades) {
  const wins = trades.filter((trade) => trade.netWin).length;
  const grossWins = trades.filter((trade) => trade.grossReturnPercent > 0).length;
  const netReturn = trades.reduce((sum, trade) => sum + Number(trade.estimatedNetReturnPercent || 0), 0);
  const grossReturn = trades.reduce((sum, trade) => sum + Number(trade.grossReturnPercent || 0), 0);
  return {
    trades: trades.length,
    tp: trades.filter((trade) => trade.outcome === "tp").length,
    stop: trades.filter((trade) => trade.outcome === "stop").length,
    timeout: trades.filter((trade) => trade.outcome === "timeout").length,
    grossWins,
    netWins: wins,
    grossWinRate: trades.length ? round(grossWins / trades.length, 4) : null,
    netWinRate: trades.length ? round(wins / trades.length, 4) : null,
    totalGrossReturnPercent: round(grossReturn, 4),
    totalEstimatedNetReturnPercent: round(netReturn, 4),
    averageEstimatedNetReturnPercent: trades.length ? round(netReturn / trades.length, 4) : null
  };
}

function executablePrice(book, side, action) {
  if (side === "long") return action === "open" ? Number(book.bestAsk) : Number(book.bestBid);
  return action === "open" ? Number(book.bestBid) : Number(book.bestAsk);
}

function applyMove(price, side, percent) {
  const move = Number(percent || 0) / 100;
  return side === "long" ? price * (1 + move) : price * (1 - move);
}

function grossReturnPercent(side, entry, exit) {
  if (!entry || !exit) return 0;
  return side === "long"
    ? ((exit - entry) / entry) * 100
    : ((entry - exit) / entry) * 100;
}

function readInt(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function readNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function readBoolean(name, fallback) {
  if (process.env[name] === undefined) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(process.env[name]).toLowerCase());
}
