import { normalizeKlines } from "./indicators.js";
import { MarketMetadataCache } from "./marketData/marketMetadataCache.js";

class BinanceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "BinanceError";
    this.details = details;
  }
}

async function requestJson(baseUrl, path, params = {}, { timeoutMs = 8_000, attempt = 1 } = {}) {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "accept": "application/json",
        "user-agent": "bi-agent-local-signal-scanner/0.1"
      }
    });
  } catch (error) {
    const cause = error.name === "AbortError"
      ? `timeout after ${timeoutMs}ms`
      : error.cause?.code || error.cause?.message || error.message;
    throw new BinanceError(`Binance API request failed: ${cause}`, {
      url: url.toString(),
      path,
      cause,
      attempt,
      elapsedMs: Date.now() - startedAt,
      retryable: isRetryableCause(cause)
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new BinanceError(`Binance API ${response.status} ${response.statusText}`, {
      url: url.toString(),
      path,
      status: response.status,
      body: body.slice(0, 500),
      attempt,
      elapsedMs: Date.now() - startedAt,
      retryable: isRetryableStatus(response.status)
    });
  }

  return response.json();
}

async function requestJsonWithFallback(baseUrls, path, params = {}, options = {}) {
  const urls = normalizeBaseUrls(baseUrls);
  const errors = [];
  const retryCount = Math.max(0, Number(options.retryCount || 0));
  const retryBaseDelayMs = Math.max(0, Number(options.retryBaseDelayMs || 0));
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= retryCount + 1; attempt += 1) {
    let retryableFailure = false;
    for (const baseUrl of urls) {
      try {
        return await requestJson(baseUrl, path, params, { ...options, attempt });
      } catch (error) {
        const retryable = Boolean(error.details?.retryable);
        retryableFailure ||= retryable;
        errors.push({
          baseUrl,
          attempt,
          message: error.message,
          cause: error.details?.cause,
          status: error.details?.status,
          elapsedMs: error.details?.elapsedMs,
          retryable,
          url: error.details?.url
        });
      }
    }
    if (!retryableFailure || attempt > retryCount) break;
    await delay(retryBaseDelayMs * (2 ** (attempt - 1)));
  }

  throw new BinanceError(
    `Binance API request failed path=${path} attempts=${Math.max(...errors.map((item) => item.attempt), 0)} elapsed=${Date.now() - startedAt}ms: ${errors.map((item) => `${item.baseUrl}#${item.attempt} ${item.cause || item.status || item.message} (${item.elapsedMs ?? "?"}ms)`).join("; ")}`,
    { path, params, elapsedMs: Date.now() - startedAt, errors }
  );
}

export class BinanceClient {
  constructor({
    spotBaseUrl,
    futuresBaseUrl,
    spotBaseUrls,
    futuresBaseUrls,
    requestTimeoutMs = 8_000,
    requestRetryCount = 1,
    requestRetryBaseDelayMs = 250,
    metadataCacheMs = 6 * 60 * 60_000,
    metadataStaleMs = 24 * 60 * 60_000
  }) {
    this.spotBaseUrls = normalizeBaseUrls(spotBaseUrls || spotBaseUrl);
    this.futuresBaseUrls = normalizeBaseUrls(futuresBaseUrls || futuresBaseUrl);
    this.spotBaseUrl = this.spotBaseUrls[0];
    this.futuresBaseUrl = this.futuresBaseUrls[0];
    this.requestTimeoutMs = requestTimeoutMs;
    this.requestRetryCount = requestRetryCount;
    this.requestRetryBaseDelayMs = requestRetryBaseDelayMs;
    this.futuresMetricsCache = new Map();
    this.metadataCache = new MarketMetadataCache({ ttlMs: metadataCacheMs, staleMs: metadataStaleMs });
    this.health = {
      spot: createRequestHealth(),
      futures: createRequestHealth(),
      metadata: {}
    };
  }

  async getSpotSymbols() {
    const [exchange, tickers, books] = await Promise.all([
      this.getExchangeInfo("spot"),
      this.requestSpot("/api/v3/ticker/24hr"),
      this.requestSpot("/api/v3/ticker/bookTicker")
    ]);
    return mergeMarketData("spot", exchange.symbols, tickers, books);
  }

  async getFuturesSymbols() {
    const [exchange, tickers, books, premium] = await Promise.all([
      this.getExchangeInfo("futures"),
      this.requestFutures("/fapi/v1/ticker/24hr"),
      this.requestFutures("/fapi/v1/ticker/bookTicker"),
      this.requestFutures("/fapi/v1/premiumIndex")
    ]);
    const fundingBySymbol = new Map(
      premium.map((item) => [item.symbol, Number(item.lastFundingRate || 0)])
    );
    return mergeMarketData("futures", exchange.symbols, tickers, books, fundingBySymbol);
  }

  async getExchangeInfo(marketType, { force = false } = {}) {
    const path = marketType === "spot" ? "/api/v3/exchangeInfo" : "/fapi/v1/exchangeInfo";
    const result = await this.metadataCache.getOrLoad(
      `${marketType}:exchangeInfo`,
      () => this.requestMarket(marketType, path),
      { force }
    );
    this.health.metadata[marketType] = {
      source: result.source,
      stale: result.stale,
      loadedAt: new Date(result.loadedAt).toISOString(),
      ageMs: result.ageMs,
      fallbackError: result.fallbackError?.message || null
    };
    return result.value;
  }

  getHealth() {
    return structuredClone(this.health);
  }

  async getKlines(marketType, symbol, interval, limit = 120, options = {}) {
    const path = marketType === "spot" ? "/api/v3/klines" : "/fapi/v1/klines";
    const rows = await this.requestMarket(marketType, path, {
      symbol,
      interval,
      limit,
      startTime: options.startTime,
      endTime: options.endTime
    });
    return normalizeKlines(rows);
  }

  async getOrderBookDepth(marketType, symbol, limit = 50) {
    const path = marketType === "spot" ? "/api/v3/depth" : "/fapi/v1/depth";
    const book = await this.requestMarket(marketType, path, { symbol, limit });
    return normalizeDepth(book);
  }

  async getAggTrades(marketType, symbol, limit = 500, options = {}) {
    const path = marketType === "spot" ? "/api/v3/aggTrades" : "/fapi/v1/aggTrades";
    const rows = await this.requestMarket(marketType, path, {
      symbol,
      limit,
      startTime: options.startTime,
      endTime: options.endTime
    });
    return rows.map(normalizeAggTrade);
  }

  async getMarketMicrostructure(marketType, symbol, { depthLimit = 50, aggTradeLimit = 500 } = {}) {
    const [depthResult, tradesResult] = await Promise.allSettled([
      this.getOrderBookDepth(marketType, symbol, depthLimit),
      this.getAggTrades(marketType, symbol, aggTradeLimit)
    ]);
    const errors = [];
    const microstructure = {
      status: "ok",
      orderBook: null,
      aggressiveTrades: null,
      errors
    };

    if (depthResult.status === "fulfilled") microstructure.orderBook = depthResult.value;
    else errors.push(depthResult.reason?.message || "order book fetch failed");

    if (tradesResult.status === "fulfilled") microstructure.aggressiveTrades = tradesResult.value;
    else errors.push(tradesResult.reason?.message || "agg trades fetch failed");

    microstructure.status = errors.length
      ? microstructure.orderBook || microstructure.aggressiveTrades ? "partial" : "unavailable"
      : "ok";
    return microstructure;
  }

  async getFuturesDerivatives(symbol, { period = "15m", cacheMs = 60_000 } = {}) {
    const key = `${symbol}:${period}`;
    const cached = this.futuresMetricsCache.get(key);
    if (cached && Date.now() - cached.cachedAt < cacheMs) return cached.value;

    const requests = {
      openInterest: this.requestFutures("/fapi/v1/openInterest", { symbol }),
      openInterestHist: this.requestFutures("/futures/data/openInterestHist", { symbol, period, limit: 2 }),
      globalLongShortAccountRatio: this.requestFutures("/futures/data/globalLongShortAccountRatio", { symbol, period, limit: 2 }),
      topLongShortPositionRatio: this.requestFutures("/futures/data/topLongShortPositionRatio", { symbol, period, limit: 2 }),
      premiumIndex: this.requestFutures("/fapi/v1/premiumIndex", { symbol })
    };
    const entries = await Promise.allSettled(Object.entries(requests).map(async ([name, promise]) => [name, await promise]));
    const values = {};
    const errors = [];

    for (const entry of entries) {
      if (entry.status === "fulfilled") {
        const [name, value] = entry.value;
        values[name] = value;
      } else {
        errors.push(entry.reason?.message || "unknown futures metrics error");
      }
    }

    const latestOiHist = lastItem(values.openInterestHist);
    const previousOiHist = previousItem(values.openInterestHist);
    const latestAccountRatio = lastItem(values.globalLongShortAccountRatio);
    const latestPositionRatio = lastItem(values.topLongShortPositionRatio);
    const openInterest = Number(values.openInterest?.openInterest ?? latestOiHist?.sumOpenInterest);
    const previousOpenInterest = Number(previousOiHist?.sumOpenInterest);
    const openInterestChangePercent = Number.isFinite(openInterest) && Number.isFinite(previousOpenInterest) && previousOpenInterest
      ? ((openInterest - previousOpenInterest) / previousOpenInterest) * 100
      : null;

    const value = {
      status: errors.length
        ? Object.keys(values).length ? "partial" : "unavailable"
        : "ok",
      openInterest: finiteOrNull(openInterest),
      openInterestValue: finiteOrNull(Number(latestOiHist?.sumOpenInterestValue)),
      openInterestChangePercent: finiteOrNull(openInterestChangePercent),
      fundingRate: finiteOrNull(Number(values.premiumIndex?.lastFundingRate)),
      nextFundingTime: finiteOrNull(Number(values.premiumIndex?.nextFundingTime)),
      longShortAccountRatio: finiteOrNull(Number(latestAccountRatio?.longShortRatio)),
      longAccountPercent: finiteOrNull(Number(latestAccountRatio?.longAccount)),
      shortAccountPercent: finiteOrNull(Number(latestAccountRatio?.shortAccount)),
      topLongShortPositionRatio: finiteOrNull(Number(latestPositionRatio?.longShortRatio)),
      period,
      errors: errors.slice(0, 3)
    };

    this.futuresMetricsCache.set(key, { cachedAt: Date.now(), value });
    return value;
  }

  requestSpot(path, params = {}) {
    return this.request("spot", this.spotBaseUrls, path, params);
  }

  requestFutures(path, params = {}) {
    return this.request("futures", this.futuresBaseUrls, path, params);
  }

  async request(marketType, baseUrls, path, params = {}) {
    const startedAt = Date.now();
    const health = this.health[marketType];
    health.requestCount += 1;
    health.lastPath = path;
    try {
      const value = await requestJsonWithFallback(baseUrls, path, params, {
        timeoutMs: this.requestTimeoutMs,
        retryCount: this.requestRetryCount,
        retryBaseDelayMs: this.requestRetryBaseDelayMs
      });
      health.successCount += 1;
      health.lastSuccessAt = new Date().toISOString();
      health.lastDurationMs = Date.now() - startedAt;
      health.lastError = null;
      return value;
    } catch (error) {
      health.failureCount += 1;
      health.lastFailureAt = new Date().toISOString();
      health.lastDurationMs = Date.now() - startedAt;
      health.lastError = {
        message: error.message,
        path,
        elapsedMs: error.details?.elapsedMs ?? health.lastDurationMs,
        attempts: error.details?.errors?.at(-1)?.attempt || 1
      };
      throw error;
    }
  }

  requestMarket(marketType, path, params = {}) {
    return marketType === "spot" ? this.requestSpot(path, params) : this.requestFutures(path, params);
  }
}

function createRequestHealth() {
  return {
    requestCount: 0,
    successCount: 0,
    failureCount: 0,
    lastPath: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastDurationMs: null,
    lastError: null
  };
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableCause(cause) {
  return /timeout|timedout|econnreset|econnrefused|enotfound|fetch failed|socket/i.test(String(cause || ""));
}

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function normalizeBaseUrls(value) {
  const urls = Array.isArray(value) ? value : String(value || "").split(",");
  return urls
    .map((item) => String(item || "").trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function mergeMarketData(marketType, symbols, tickers, books, fundingBySymbol = new Map()) {
  const tickerBySymbol = new Map(tickers.map((item) => [item.symbol, item]));
  const bookBySymbol = new Map(books.map((item) => [item.symbol, item]));

  return symbols
    .filter((symbol) => {
      if (symbol.status !== "TRADING") return false;
      if (symbol.quoteAsset !== "USDT") return false;
      if (marketType === "futures" && symbol.contractType !== "PERPETUAL") return false;
      return true;
    })
    .map((symbol) => {
      const ticker = tickerBySymbol.get(symbol.symbol) || {};
      const book = bookBySymbol.get(symbol.symbol) || {};
      const bidPrice = Number(book.bidPrice || ticker.bidPrice || 0);
      const askPrice = Number(book.askPrice || ticker.askPrice || 0);
      const bidQty = Number(book.bidQty || 0);
      const askQty = Number(book.askQty || 0);
      const lastPrice = Number(ticker.lastPrice || 0);
      const mid = bidPrice && askPrice ? (bidPrice + askPrice) / 2 : lastPrice;
      const spreadPercent = mid ? ((askPrice - bidPrice) / mid) * 100 : Infinity;
      const bookQty = bidQty + askQty;

      return {
        symbol: symbol.symbol,
        baseAsset: symbol.baseAsset,
        quoteAsset: symbol.quoteAsset,
        marketType,
        lastPrice,
        priceChangePercent: Number(ticker.priceChangePercent || 0),
        quoteVolume: Number(ticker.quoteVolume || 0),
        bidPrice,
        askPrice,
        bidQty,
        askQty,
        orderBookImbalance: bookQty ? (bidQty - askQty) / bookQty : null,
        topOfBookNotional: mid && bookQty ? mid * bookQty : null,
        spreadPercent,
        fundingRate: marketType === "futures" ? fundingBySymbol.get(symbol.symbol) || 0 : null
      };
    });
}

function normalizeDepth(book = {}) {
  const bids = normalizeDepthSide(book.bids);
  const asks = normalizeDepthSide(book.asks);
  const bidNotional = sumNotional(bids);
  const askNotional = sumNotional(asks);
  const totalNotional = bidNotional + askNotional;
  const bestBid = bids[0]?.price || null;
  const bestAsk = asks[0]?.price || null;
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;

  return {
    lastUpdateId: book.lastUpdateId ?? null,
    bids,
    asks,
    bidNotional,
    askNotional,
    totalNotional,
    imbalance: totalNotional ? (bidNotional - askNotional) / totalNotional : null,
    bestBid,
    bestAsk,
    spreadPercent: mid ? ((bestAsk - bestBid) / mid) * 100 : null,
    largestBidWall: largestWall(bids, mid),
    largestAskWall: largestWall(asks, mid)
  };
}

function normalizeDepthSide(rows = []) {
  return rows
    .map(([price, quantity]) => {
      const numericPrice = Number(price);
      const numericQuantity = Number(quantity);
      return {
        price: numericPrice,
        quantity: numericQuantity,
        notional: numericPrice * numericQuantity
      };
    })
    .filter((item) => Number.isFinite(item.price) && Number.isFinite(item.quantity));
}

function normalizeAggTrade(row = {}) {
  const price = Number(row.p);
  const quantity = Number(row.q);
  const quoteQuantity = price * quantity;
  const side = row.m ? "sell" : "buy";
  return {
    id: row.a,
    price,
    quantity,
    quoteQuantity,
    firstTradeId: row.f,
    lastTradeId: row.l,
    time: Number(row.T),
    isBuyerMaker: Boolean(row.m),
    side
  };
}

function sumNotional(rows) {
  return rows.reduce((sum, item) => sum + (Number(item.notional) || 0), 0);
}

function largestWall(rows, mid) {
  const wall = rows.reduce((best, item) => Number(item.notional || 0) > Number(best?.notional || 0) ? item : best, null);
  if (!wall) return null;
  return {
    price: wall.price,
    quantity: wall.quantity,
    notional: wall.notional,
    distancePercent: mid ? ((wall.price - mid) / mid) * 100 : null
  };
}

function lastItem(value) {
  return Array.isArray(value) ? value[value.length - 1] || null : value || null;
}

function previousItem(value) {
  return Array.isArray(value) && value.length > 1 ? value[value.length - 2] : null;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}
