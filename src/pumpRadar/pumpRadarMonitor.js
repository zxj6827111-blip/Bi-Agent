import { join } from "node:path";
import { BinanceClient } from "../binanceClient.js";
import { config } from "../config.js";
import { isFeishuEnabled, sendFeishuText } from "../feishuNotifier.js";
import { BinanceFuturesStream } from "../marketData/binanceFuturesStream.js";
import { CrossVenueClient } from "../marketData/crossVenueClient.js";
import { PumpRadarEventStore } from "./eventStore.js";
import { openPaperPosition, updatePaperPosition, closePaperPosition } from "./paperExecution.js";
import { PumpDetector } from "./pumpDetector.js";
import { PumpStateMachine } from "./pumpStateMachine.js";
import { RollingPriceWindow, RollingTradeWindow } from "./rollingWindow.js";

export class PumpRadarMonitor {
  constructor({
    options = config.pumpRadar,
    binanceClient = new BinanceClient(config.binance),
    stream = null,
    crossVenueClient = null,
    eventStore = null,
    now = () => Date.now(),
    logger = console
  } = {}) {
    this.options = options;
    this.binanceClient = binanceClient;
    this.now = now;
    this.logger = logger;
    this.stream = stream || new BinanceFuturesStream({
      baseUrl: options.streamUrl,
      maxDetailedSymbols: options.maxCandidates + options.maxOpenPositions
    });
    this.crossVenue = crossVenueClient || new CrossVenueClient({
      minMovePercent: options.crossVenueMinMovePercent
    });
    const outputDir = options.outputDir || join(process.cwd(), "data", "pump-radar");
    this.store = eventStore || new PumpRadarEventStore({ outputDir, now });
    this.detector = new PumpDetector(options);
    this.machine = new PumpStateMachine({ cooldownMs: options.cooldownSeconds * 1_000, now });
    this.priceWindows = new Map();
    this.tradeWindows = new Map();
    this.tickers = new Map();
    this.books = new Map();
    this.depths = new Map();
    this.universeSymbols = new Set();
    this.positions = new Map();
    this.closedTrades = [];
    this.pendingEvaluations = new Set();
    this.lastPositionEvaluation = new Map();
    this.timers = new Set();
    this.notificationQueue = Promise.resolve();
    this.running = false;
    this.stopPromise = new Promise((resolve) => {
      this.resolveStop = resolve;
    });
    this.state = createInitialState(options, outputDir, now());
  }

  async start() {
    if (this.running) return this.state;
    this.running = true;
    await this.store.initialize();
    this.#attachStreamHandlers();
    await this.#refreshUniverse().catch((error) => {
      this.state.universe.metadataSource = "stream_book_fallback";
      this.#recordError("universe", error);
    });
    this.stream.start();
    this.state.status = "running";
    this.state.updatedAt = new Date(this.now()).toISOString();
    await this.#recordEvent("radar_started", {
      mode: "paper_only",
      universeSymbols: this.universeSymbols.size
    });
    await this.#persistSnapshot();

    this.#setInterval(() => this.#refreshCandidatePool(), this.options.candidateRefreshSeconds * 1_000);
    this.#setInterval(() => this.#persistSnapshot(), this.options.snapshotSeconds * 1_000);
    this.#setInterval(() => this.#checkHealth(), 2_000);
    this.#setInterval(
      () => this.#refreshUniverse().catch((error) => this.#recordError("universe", error)),
      Math.max(10 * 60_000, this.options.candidateRefreshSeconds * 20_000)
    );

    if (this.options.durationSeconds > 0) {
      const timer = setTimeout(() => this.stop("duration_complete"), this.options.durationSeconds * 1_000);
      timer.unref?.();
      this.timers.add(timer);
    }
    this.logger.log(`[pump-radar] started mode=paper_only universe=${this.universeSymbols.size} output=${this.state.outputDir}`);
    return this.state;
  }

  wait() {
    return this.stopPromise;
  }

  async stop(reason = "shutdown") {
    if (!this.running) return this.state;
    this.running = false;
    for (const timer of this.timers) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    this.timers.clear();
    this.stream.stop();

    for (const position of [...this.positions.values()]) {
      const book = this.books.get(position.symbol);
      if (Number(book?.bidPrice) > 0) await this.#closePosition(position.symbol, reason, book);
    }
    this.state.status = reason === "duration_complete" ? "completed" : "stopped";
    this.state.stopReason = reason;
    this.state.finishedAt = new Date(this.now()).toISOString();
    this.state.updatedAt = this.state.finishedAt;
    await this.#recordEvent("radar_stopped", { reason });
    await this.#persistSnapshot();
    await this.notificationQueue.catch(() => {});
    await this.store.flush();
    this.resolveStop(this.state);
    this.logger.log(`[pump-radar] stopped reason=${reason}`);
    return this.state;
  }

  getState() {
    return this.#buildSnapshot();
  }

  #attachStreamHandlers() {
    this.stream.on("ticker", (ticker) => this.#handleTicker(ticker));
    this.stream.on("book", (book) => this.#handleBook(book));
    this.stream.on("trade", (trade) => this.#handleTrade(trade));
    this.stream.on("depth", (depth) => this.#handleDepth(depth));
    this.stream.on("status", () => this.#checkHealth());
    this.stream.on("streamError", ({ kind, error }) => this.#recordError(`stream:${kind}`, error));
  }

  #handleTicker(ticker) {
    if (!this.running || !ticker?.symbol || !isStreamPerpetualUsdt(ticker.symbol)) return;
    if (!this.universeSymbols.has(ticker.symbol)) {
      this.universeSymbols.add(ticker.symbol);
      this.state.universe.totalPerpetualUsdt = this.universeSymbols.size;
      this.state.universe.streamDiscoveredSymbols += 1;
      if (!this.state.universe.metadataSource) this.state.universe.metadataSource = "stream_book_fallback";
    }
    const previous = this.tickers.get(ticker.symbol);
    if (previous && Number(ticker.eventTime) < Number(previous.eventTime)) return;
    const topBookNotional = Number(ticker.bidPrice || 0) * Number(ticker.bidQty || 0)
      + Number(ticker.askPrice || 0) * Number(ticker.askQty || 0);
    const incomingQuoteVolume = finiteValue(ticker.quoteVolume);
    const previousQuoteVolume = finiteValue(previous?.quoteVolume);
    const hasRestVolume = incomingQuoteVolume != null || previous?.liquiditySource === "binance_rest_24h";
    const quoteVolume = incomingQuoteVolume != null
      ? incomingQuoteVolume
      : previousQuoteVolume != null
        ? previousQuoteVolume
        : topBookNotional >= this.options.minDiscoveryBookNotional
          ? this.options.minQuoteVolume
          : null;
    const mergedTicker = {
      ...(previous || {}),
      ...ticker,
      quoteVolume,
      topBookNotional,
      liquiditySource: hasRestVolume ? "binance_rest_24h" : "binance_book_proxy"
    };
    this.tickers.set(ticker.symbol, mergedTicker);
    this.state.metrics.tickerEvents += 1;

    const history = getOrCreate(this.priceWindows, ticker.symbol, () => new RollingPriceWindow());
    history.add(ticker.eventTime, ticker.closePrice, { quoteVolume });
    const record = this.machine.get(ticker.symbol);
    if (record?.state === "watching") {
      this.#queueCandidateEvaluation(ticker.symbol);
      return;
    }
    if (record || !this.#mainSourceReady() || !this.machine.canWatch(ticker.symbol, ticker.eventTime)) return;
    if (this.machine.list(["watching", "confirmed"]).length >= this.options.maxCandidates) return;

    const discovery = this.detector.evaluateDiscovery({
      symbol: ticker.symbol,
      history,
      quoteVolume,
      now: ticker.eventTime
    });
    if (!discovery.detected) return;

    const watched = this.machine.startWatching(ticker.symbol, discovery, ticker.eventTime);
    if (!watched) return;
    this.state.metrics.discoveries += 1;
    this.#syncDetailedSymbols();
    this.#recordEvent("pump_detected", { symbol: ticker.symbol, discovery });
    if (this.options.crossVenueEnabled) {
      watched.crossVenuePrime = this.crossVenue.prime(ticker.symbol, ticker.eventTime)
        .catch((error) => {
          this.#recordError(`cross_venue_prime:${ticker.symbol}`, error);
          return null;
        });
    }
  }

  #handleBook(book) {
    if (!this.running || !book?.symbol || !this.universeSymbols.has(book.symbol)) return;
    const previous = this.books.get(book.symbol);
    if (previous && Number(book.eventTime) < Number(previous.eventTime)) return;
    this.books.set(book.symbol, book);
    this.state.metrics.bookEvents += 1;

    if (this.machine.get(book.symbol)?.state === "watching") this.#queueCandidateEvaluation(book.symbol);

    const position = this.positions.get(book.symbol);
    if (!position) return;
    const lastEvaluation = this.lastPositionEvaluation.get(book.symbol) || 0;
    if (book.eventTime - lastEvaluation < 750) return;
    this.lastPositionEvaluation.set(book.symbol, book.eventTime);
    const history = this.priceWindows.get(book.symbol);
    const trades = this.tradeWindows.get(book.symbol)?.stats(5_000, book.eventTime) || {};
    const result = updatePaperPosition(position, {
      bidPrice: book.bidPrice,
      now: book.eventTime,
      move5sPercent: history?.changePercent(5_000, book.eventTime),
      buyRatio: trades.buyRatio,
      momentumExitPercent: this.options.momentumExitPercent
    });
    this.positions.set(book.symbol, result.position);
    if (result.exit) this.#closePosition(book.symbol, result.exit, book).catch((error) => this.#recordError("paper_exit", error));
  }

  #handleTrade(trade) {
    if (!this.running || !trade?.symbol || !this.machine.get(trade.symbol)) return;
    getOrCreate(this.tradeWindows, trade.symbol, () => new RollingTradeWindow()).add(trade);
    this.state.metrics.tradeEvents += 1;
    if (this.machine.get(trade.symbol)?.state === "watching") this.#queueCandidateEvaluation(trade.symbol);
  }

  #handleDepth(depth) {
    if (!this.running || !depth?.symbol || !this.machine.get(depth.symbol)) return;
    const previous = this.depths.get(depth.symbol);
    if (previous && Number(depth.eventTime) < Number(previous.eventTime)) return;
    this.depths.set(depth.symbol, depth);
    this.state.metrics.depthEvents += 1;
    if (this.machine.get(depth.symbol)?.state === "watching") this.#queueCandidateEvaluation(depth.symbol);
  }

  #queueCandidateEvaluation(symbol) {
    if (this.pendingEvaluations.has(symbol)) return;
    this.pendingEvaluations.add(symbol);
    Promise.resolve()
      .then(() => this.#evaluateCandidate(symbol))
      .catch((error) => this.#recordError(`candidate:${symbol}`, error))
      .finally(() => this.pendingEvaluations.delete(symbol));
  }

  async #evaluateCandidate(symbol) {
    if (!this.running) return;
    const record = this.machine.get(symbol);
    if (!record || record.state !== "watching") return;
    const now = this.now();
    const ticker = this.tickers.get(symbol);
    let crossVenue = record.crossVenueConfirmation || null;
    const canRefreshCrossVenue = this.options.crossVenueEnabled
      && now - Number(record.discovery.detectedAt) >= this.options.watchMinSeconds * 1_000
      && now - Number(record.crossVenueCheckedAt || 0) >= 4_000;
    if (canRefreshCrossVenue) {
      await record.crossVenuePrime;
      crossVenue = await this.crossVenue.confirm(symbol, { binancePrice: ticker?.closePrice, now });
      if (!this.running || this.machine.get(symbol)?.state !== "watching") return;
      record.crossVenueConfirmation = crossVenue;
      record.crossVenueCheckedAt = now;
    }

    const confirmation = this.detector.evaluateConfirmation({
      discovery: record.discovery,
      currentPrice: ticker?.closePrice,
      book: this.books.get(symbol),
      depth: this.depths.get(symbol),
      trades: this.tradeWindows.get(symbol)?.stats(10_000, now) || {},
      crossVenue,
      now
    });
    record.lastConfirmation = confirmation;
    if (confirmation.status === "pending") return;

    if (confirmation.status === "rejected") {
      this.machine.reject(symbol, confirmation.failures[0] || confirmation.pendingReasons[0] || "confirmation_timeout", confirmation, now);
      this.state.metrics.rejections += 1;
      await this.#recordEvent("pump_rejected", { symbol, confirmation });
      this.#syncDetailedSymbols();
      return;
    }

    this.machine.confirm(symbol, confirmation, now);
    this.state.metrics.confirmations += 1;
    await this.#recordEvent("pump_confirmed", { symbol, confirmation, discovery: record.discovery });
    this.#notify("confirmed", `[Bi-Agent Radar] ${symbol} pump confirmed score=${confirmation.score}`);

    const book = this.books.get(symbol);
    if (!this.#mainSourceReady() || this.positions.size >= this.options.maxOpenPositions || !this.#freshBook(book, now)) {
      const reason = !this.#mainSourceReady() ? "binance_source_unhealthy" : this.positions.size >= this.options.maxOpenPositions ? "position_limit" : "stale_execution_book";
      this.machine.reject(symbol, reason, null, now);
      await this.#recordEvent("entry_blocked", { symbol, reason });
      this.#syncDetailedSymbols();
      return;
    }

    const position = openPaperPosition({
      symbol,
      book,
      now,
      notional: this.options.paperNotional,
      feeRate: config.tradingCosts.futuresFeeRate,
      slippagePercent: config.tradingCosts.slippagePercent,
      initialStopPercent: this.options.initialStopPercent,
      takeProfitPercent: this.options.takeProfitPercent,
      trailingActivationPercent: this.options.trailingActivationPercent,
      trailingDistancePercent: this.options.trailingDistancePercent,
      maxHoldSeconds: this.options.maxHoldSeconds,
      signal: { discovery: record.discovery, confirmation }
    });
    this.positions.set(symbol, position);
    this.machine.open(symbol, position.id, now);
    this.state.metrics.entries += 1;
    await this.#recordEvent("paper_entry", { symbol, position: compactPosition(position) });
    this.#notify("entry", `[Bi-Agent Radar] PAPER ENTRY ${symbol} price=${formatNumber(position.entryPrice)} notional=${position.notional} USDT`);
    this.#syncDetailedSymbols();
  }

  async #closePosition(symbol, reason, book = this.books.get(symbol)) {
    const position = this.positions.get(symbol);
    if (!position) return null;
    const closed = closePaperPosition(position, { bidPrice: book?.bidPrice, reason, now: this.now() });
    this.positions.delete(symbol);
    this.closedTrades.push(closed);
    if (this.closedTrades.length > 200) this.closedTrades.splice(0, this.closedTrades.length - 200);
    this.machine.close(symbol, reason, this.now());
    this.state.metrics.exits += 1;
    this.state.metrics.netPnl = this.closedTrades.reduce((sum, trade) => sum + Number(trade.netPnl || 0), 0);
    await this.#recordEvent("paper_exit", { symbol, trade: compactTrade(closed) });
    this.#notify("exit", `[Bi-Agent Radar] PAPER EXIT ${symbol} reason=${reason} net=${formatNumber(closed.netReturnPercent)}%`);
    this.#syncDetailedSymbols();
    return closed;
  }

  async #refreshUniverse() {
    const [exchangeInfo, tickers] = await Promise.all([
      this.binanceClient.getExchangeInfo("futures"),
      this.binanceClient.requestFutures("/fapi/v1/ticker/24hr")
    ]);
    const tickerBySymbol = new Map(tickers.map((ticker) => [ticker.symbol, ticker]));
    const symbols = exchangeInfo.symbols
      .filter((symbol) => symbol.status === "TRADING" && symbol.quoteAsset === "USDT" && symbol.contractType === "PERPETUAL")
      .map((symbol) => symbol.symbol);
    this.universeSymbols = new Set(symbols);
    for (const symbol of symbols) {
      const ticker = tickerBySymbol.get(symbol);
      if (!ticker) continue;
      const existing = this.tickers.get(symbol);
      if (!existing) {
        this.tickers.set(symbol, {
          symbol,
          eventTime: this.now(),
          closePrice: Number(ticker.lastPrice),
          quoteVolume: Number(ticker.quoteVolume),
          liquiditySource: "binance_rest_24h"
        });
      }
    }
    this.state.universe.totalPerpetualUsdt = symbols.length;
    this.state.universe.metadataSource = "binance_futures_rest";
    this.state.universe.lastMetadataRefreshAt = new Date(this.now()).toISOString();
    this.#refreshCandidatePool();
    this.state.health.rest = this.binanceClient.getHealth();
  }

  #refreshCandidatePool() {
    this.machine.cleanup(this.now());
    const candidates = [...this.tickers.values()]
      .filter((ticker) => this.universeSymbols.has(ticker.symbol) && Number(ticker.quoteVolume) >= this.options.minQuoteVolume)
      .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume));
    const limit = Number(this.options.maxUniverseSymbols) > 0 ? this.options.maxUniverseSymbols : candidates.length;
    this.state.universe.liquidSymbols = candidates.length;
    this.state.universe.candidatePool = candidates.slice(0, limit).map((ticker) => ({
      symbol: ticker.symbol,
      quoteVolume: ticker.quoteVolume,
      price: ticker.closePrice
    }));
    this.state.universe.lastCandidateRefreshAt = new Date(this.now()).toISOString();
  }

  #checkHealth() {
    if (!this.running) return;
    const streamStatus = this.stream.getStatus();
    this.state.health.stream = streamStatus;
    this.state.health.rest = this.binanceClient.getHealth();
    this.state.health.crossVenue = this.crossVenue.getHealth();
    const ready = this.#mainSourceReady(streamStatus);
    const previous = this.state.health.mainSource;
    const next = ready ? "healthy" : "degraded";
    this.state.health.mainSource = next;
    if (previous !== next && previous !== "starting") {
      const event = next === "healthy" ? "source_recovered" : "source_degraded";
      this.#recordEvent(event, { stream: streamStatus.market });
      this.#notify(event, `[Bi-Agent Radar] Binance Futures stream ${next}; ${ready ? "paper entries resumed" : "new paper entries blocked"}`);
    }
  }

  #mainSourceReady(status = this.stream.getStatus()) {
    const market = status.market;
    const lastMessageMs = Date.parse(market.lastMessageAt || "");
    return Boolean(market.connected)
      && Number.isFinite(lastMessageMs)
      && this.now() - lastMessageMs <= this.options.streamStaleSeconds * 1_000;
  }

  #freshBook(book, now = this.now()) {
    return Number(book?.askPrice) > 0
      && Number(book?.bidPrice) > 0
      && now - Number(book?.eventTime || 0) <= this.options.streamStaleSeconds * 1_000;
  }

  #syncDetailedSymbols() {
    this.stream.setDetailedSymbols(this.machine.detailedSymbols());
  }

  async #recordEvent(type, payload = {}) {
    try {
      const event = await this.store.append(type, payload, this.now());
      this.state.recentEvents.push(compactEvent(event));
      if (this.state.recentEvents.length > 50) this.state.recentEvents.splice(0, this.state.recentEvents.length - 50);
      return event;
    } catch (error) {
      this.#recordError("event_store", error);
      return null;
    }
  }

  #recordError(scope, error) {
    const item = {
      scope,
      at: new Date(this.now()).toISOString(),
      message: error?.message || String(error)
    };
    this.state.errors.push(item);
    if (this.state.errors.length > 30) this.state.errors.splice(0, this.state.errors.length - 30);
    this.logger.warn(`[pump-radar][${scope}] ${item.message}`);
  }

  #notify(event, text) {
    if (!this.options.notifyEvents.includes(event) || !isFeishuEnabled()) return;
    this.notificationQueue = this.notificationQueue
      .then(() => sendFeishuText(text))
      .catch((error) => this.#recordError(`feishu:${event}`, error));
  }

  #setInterval(callback, delayMs) {
    const timer = setInterval(() => {
      Promise.resolve(callback()).catch((error) => this.#recordError("timer", error));
    }, Math.max(250, delayMs));
    timer.unref?.();
    this.timers.add(timer);
    return timer;
  }

  async #persistSnapshot() {
    this.state.updatedAt = new Date(this.now()).toISOString();
    await this.store.writeSnapshot(this.#buildSnapshot());
  }

  #buildSnapshot() {
    const records = this.machine.list();
    return {
      ...this.state,
      health: {
        ...this.state.health,
        stream: this.stream.getStatus(),
        rest: this.binanceClient.getHealth(),
        crossVenue: this.crossVenue.getHealth()
      },
      candidates: records
        .filter((record) => ["watching", "confirmed"].includes(record.state))
        .map(compactCandidate),
      positions: [...this.positions.values()].map(compactPosition),
      trades: this.closedTrades.slice(-100).map(compactTrade),
      summary: summarizeTrades(this.closedTrades)
    };
  }
}

function createInitialState(options, outputDir, now) {
  return {
    version: 1,
    mode: "binance_futures_pump_radar_paper_only",
    status: "starting",
    startedAt: new Date(now).toISOString(),
    finishedAt: null,
    updatedAt: new Date(now).toISOString(),
    stopReason: null,
    outputDir,
    policy: {
      discoverySource: "Binance Futures WebSocket",
      crossVenueRole: "confirmation_only",
      execution: "paper_only",
      targetDetectionLatencySeconds: "1-2",
      snapshotIntervalSeconds: options.snapshotSeconds
    },
    options: sanitizeOptions(options),
    universe: {
      totalPerpetualUsdt: 0,
      streamDiscoveredSymbols: 0,
      liquidSymbols: 0,
      metadataSource: null,
      candidatePool: [],
      lastMetadataRefreshAt: null,
      lastCandidateRefreshAt: null
    },
    health: {
      mainSource: "starting",
      stream: null,
      rest: null,
      crossVenue: null
    },
    metrics: {
      tickerEvents: 0,
      bookEvents: 0,
      tradeEvents: 0,
      depthEvents: 0,
      discoveries: 0,
      confirmations: 0,
      rejections: 0,
      entries: 0,
      exits: 0,
      netPnl: 0
    },
    candidates: [],
    positions: [],
    trades: [],
    recentEvents: [],
    errors: []
  };
}

function sanitizeOptions(options) {
  return Object.fromEntries(Object.entries(options).filter(([key]) => !/secret|token|key/i.test(key)));
}

function compactCandidate(record) {
  return {
    symbol: record.symbol,
    state: record.state,
    enteredAt: new Date(record.enteredAt).toISOString(),
    discovery: record.discovery,
    confirmation: record.lastConfirmation || record.confirmation || null
  };
}

function compactPosition(position) {
  return {
    id: position.id,
    symbol: position.symbol,
    side: position.side,
    status: position.status,
    openedAt: position.openedAt,
    entryPrice: position.entryPrice,
    lastPrice: position.lastPrice,
    stopPrice: position.stopPrice,
    takeProfitPrice: position.takeProfitPrice,
    trailingStopPrice: position.trailingStopPrice,
    peakPrice: position.peakPrice,
    notional: position.notional
  };
}

function compactTrade(trade) {
  return {
    id: trade.id,
    symbol: trade.symbol,
    openedAt: trade.openedAt,
    closedAt: trade.closedAt,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    grossReturnPercent: trade.grossReturnPercent,
    netReturnPercent: trade.netReturnPercent,
    netPnl: trade.netPnl,
    holdSeconds: trade.holdSeconds,
    exitReason: trade.exitReason
  };
}

function compactEvent(event) {
  return {
    type: event.type,
    timestamp: event.timestamp,
    symbol: event.symbol || event.position?.symbol || event.trade?.symbol || null,
    reason: event.reason || event.trade?.exitReason || null
  };
}

function summarizeTrades(trades) {
  const netPnl = trades.reduce((sum, trade) => sum + Number(trade.netPnl || 0), 0);
  const wins = trades.filter((trade) => Number(trade.netPnl) > 0).length;
  return {
    completedTrades: trades.length,
    wins,
    losses: trades.length - wins,
    winRate: trades.length ? wins / trades.length : null,
    netPnl,
    averageNetReturnPercent: trades.length
      ? trades.reduce((sum, trade) => sum + Number(trade.netReturnPercent || 0), 0) / trades.length
      : null
  };
}

function getOrCreate(map, key, factory) {
  if (!map.has(key)) map.set(key, factory());
  return map.get(key);
}

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(6).replace(/0+$/, "").replace(/\.$/, "") : "-";
}

function isStreamPerpetualUsdt(symbol) {
  return /^[A-Z0-9]+USDT$/.test(String(symbol || ""));
}

function finiteValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
