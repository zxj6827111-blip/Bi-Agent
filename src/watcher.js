import { BinanceClient } from "./binanceClient.js";
import { config } from "./config.js";
import { analyzeSignal, analyzeWatchState } from "./aiAnalyzer.js";
import { buildMarketSnapshot, filterTradableSymbols, generateSignalsFromSnapshot, reviewSignalsForQuality } from "./signalEngine.js";
import { buildWatchState } from "./watchSignalEngine.js";
import { applyWatchLifecycle, lifecycleEventsToAlerts } from "./watchLifecycle.js";
import { asFuturesProxy, enrichMarketWithFusion, withMarketSource } from "./marketFusion.js";
import { buildMarketRegime, enrichMarketWithDirection } from "./directionEngine.js";
import {
  applyAiReviewToMarketClassification,
  attachMarketSignalClassification,
  classifyMarketSignal,
  compareClassifiedMarketSignals,
  evaluateGlobalSignalFilter,
  marketSignalAction
} from "./marketSignalClassifier.js";
import { mapWithConcurrency } from "./utils.js";
import { upsertPaperTradeFromPosition } from "./store.js";
import { notifyFeishuLifecycleAlerts, notifyFeishuMarketAlerts } from "./feishuNotifier.js";

const client = new BinanceClient(config.binance);
const WATCH_INTERVALS = ["1m", "5m", "15m"];
const MAX_WATCH_SYMBOLS = 12;
const WATCH_CONCURRENCY = 3;

let watcher = null;
let aiInFlightBySymbol = new Set();
let watchGeneration = 0;
let startInFlight = false;
let refreshInFlightGeneration = null;

export function getWatchStatus() {
  return serializeWatcher(watcher || idleWatcher());
}

export async function startWatch({ symbol, symbols, marketType = "futures", refreshSeconds = 20, scope = "symbols", marketScope = false } = {}) {
  if (startInFlight) throw new Error("分时监控正在启动，请稍后。");
  const rawSymbolInput = symbols ?? symbol;
  const safeScope = normalizeWatchScope({ scope, marketScope, input: rawSymbolInput });
  const isMarketScope = safeScope === "market";
  const normalizedSymbols = isMarketScope ? [] : normalizeSymbols(rawSymbolInput);
  if (!isMarketScope && !normalizedSymbols.length) throw new Error("请输入币种，例如 BTCUSDT、ETHUSDT；如需全市场自动发现，请勾选全市场模式。");
  const safeMarketType = normalizeMarketType(marketType);
  const safeRefreshSeconds = normalizeRefreshSeconds(refreshSeconds, isMarketScope);

  startInFlight = true;
  stopWatch();
  const generation = watchGeneration + 1;
  watchGeneration = generation;
  watcher = {
    status: "starting",
    scope: safeScope,
    symbols: normalizedSymbols,
    symbol: normalizedSymbols[0],
    marketType: safeMarketType,
    refreshSeconds: safeRefreshSeconds,
    startedAt: new Date().toISOString(),
    message: isMarketScope
      ? "正在初始化全市场多空发现..."
      : `正在初始化 ${normalizedSymbols.length} 只币的分时监控...`,
    currents: {},
    marketAlerts: [],
    marketScan: null,
    history: [],
    alerts: {},
    errors: {},
    positions: {},
    error: null,
    isRefreshing: false,
    lastRefreshStartedAt: null,
    lastRefreshedAt: null,
    lastRefreshDurationMs: null,
    nextRefreshAt: null,
    timer: null,
    generation
  };

  try {
    await refreshWatch({ allowStarting: true, generation });
    if (!watcher || watcher.generation !== generation) throw new Error("分时监控启动被新的任务替换。");
    watcher.status = "running";
    scheduleNextWatchRefresh(generation);
  } catch (error) {
    watcher = idleWatcher(`分时监控启动失败：${error.message}`);
    watcher.error = error.message;
    throw error;
  } finally {
    startInFlight = false;
  }

  return getWatchStatus();
}

export function stopWatch() {
  watchGeneration += 1;
  aiInFlightBySymbol = new Set();
  if (watcher?.timer) clearInterval(watcher.timer);
  watcher = watcher
    ? {
        ...watcher,
        status: "paused",
        message: "分时监控已暂停，保留最近一次结果。",
        isRefreshing: false,
        nextRefreshAt: null,
        timer: null
      }
    : idleWatcher("分时监控未启动。");
  return getWatchStatus();
}

export async function refreshWatch({ allowStarting = false, generation = watcher?.generation, resetTimer = true } = {}) {
  if (!watcher) return getWatchStatus();
  if (watcher.generation !== generation) return getWatchStatus();
  if (watcher.status !== "running" && !(allowStarting && watcher.status === "starting")) return getWatchStatus();
  if (refreshInFlightGeneration === generation && !allowStarting) return getWatchStatus();

  refreshInFlightGeneration = generation;
  const refreshStarted = Date.now();
  try {
    watcher.isRefreshing = true;
    watcher.lastRefreshStartedAt = new Date(refreshStarted).toISOString();
    watcher.nextRefreshAt = null;
    if (watcher.scope === "market") {
      return await refreshMarketWatch({ refreshStarted, generation, allowStarting });
    }
    watcher.message = `正在刷新 ${watcher.symbols.length} 只币分时状态...`;
    const marketCatalog = await loadMarketCatalog();
    const regime = buildMarketRegime({
      spotMarkets: marketCatalog.spot,
      futuresMarkets: marketCatalog.futures,
      preferredMarketType: watcher.marketType
    });
    const previousCurrents = watcher.currents || {};
    const results = await mapWithConcurrency(watcher.symbols, WATCH_CONCURRENCY, async (symbol) => {
      try {
        const rawMarket = resolveMarketFromCatalog(symbol, watcher.marketType, marketCatalog);
        const market = await hydrateMarketForSignal(rawMarket, marketCatalog, regime);
        const klineMarketType = market.dataSourceMarketType || market.marketType;
        const candlesByInterval = {};
        for (const interval of WATCH_INTERVALS) {
          candlesByInterval[interval] = await client.getKlines(klineMarketType, market.symbol, interval, 120);
        }

        const baseState = buildWatchState({ market, candlesByInterval });
        const current = {
          ...baseState,
          ai: pendingAi(baseState),
          marketType: market.marketType,
          actualMarketType: market.actualMarketType || market.marketType,
          dataSourceMarketType: klineMarketType,
          isFuturesProxy: Boolean(market.isFuturesProxy),
          marketNotice: market.marketNotice || null,
          proxyReason: market.proxyReason || null
        };
        return { symbol, current, baseState, error: null };
      } catch (error) {
        return { symbol, current: null, baseState: null, error: error.message };
      }
    });

    if (!watcher || watcher.generation !== generation) return getWatchStatus();

    const nextCurrents = { ...previousCurrents };
    const nextErrors = {};
    const events = [];
    let updatedCount = 0;

    for (const result of results) {
      if (result.current) {
        const previousAction = previousCurrents[result.symbol]?.alert?.action;
        const lifecycle = applyWatchLifecycle({
          current: result.current,
          position: watcher.positions?.[result.symbol] || null
        });
        nextCurrents[result.symbol] = lifecycle.current;
        watcher.positions = {
          ...(watcher.positions || {}),
          [result.symbol]: lifecycle.position
        };
        const watchEvent = makeWatchEvent(lifecycle.current, previousAction);
        events.push(watchEvent, ...lifecycle.events);
        persistPaperTrade(lifecycle.current, lifecycle.position, lifecycle.events);
        const lifecycleAlerts = appendLifecycleAlerts(lifecycle.current, lifecycle.events);
        dispatchFeishuNotifications(notifyFeishuLifecycleAlerts(lifecycle.current, lifecycleAlerts));
        appendSwingAlert(lifecycle.current, previousCurrents[result.symbol]);
        updatedCount += 1;
        scheduleWatchAi(result.symbol, lifecycle.current, lifecycle.current.updatedAt, generation);
      } else {
        nextErrors[result.symbol] = result.error || "刷新失败";
      }
    }

    if (!updatedCount && allowStarting) {
      const errorText = Object.entries(nextErrors)
        .map(([symbol, error]) => `${symbol}: ${error}`)
        .join("；");
      throw new Error(errorText || "没有币种刷新成功");
    }

    watcher.currents = nextCurrents;
    watcher.errors = nextErrors;
    watcher.history = [...events, ...watcher.history].slice(0, 80);
    watcher.lastRefreshedAt = new Date().toISOString();
    watcher.lastRefreshDurationMs = Date.now() - refreshStarted;
    watcher.message = `${updatedCount}/${watcher.symbols.length} 只币已更新${Object.keys(nextErrors).length ? "，部分失败" : ""}。`;
    watcher.error = Object.keys(nextErrors).length ? "部分币种刷新失败" : null;
    return getWatchStatus();
  } finally {
    if (watcher?.generation === generation) {
      watcher.isRefreshing = false;
      if (resetTimer && watcher.status === "running") scheduleNextWatchRefresh(generation);
    }
    if (refreshInFlightGeneration === generation) refreshInFlightGeneration = null;
  }
}

function scheduleNextWatchRefresh(generation) {
  if (!watcher || watcher.generation !== generation || watcher.status !== "running") return;
  if (watcher.timer) clearTimeout(watcher.timer);
  const delay = watcher.refreshSeconds * 1000;
  watcher.nextRefreshAt = new Date(Date.now() + delay).toISOString();
  watcher.timer = setTimeout(async () => {
    if (!watcher || watcher.generation !== generation || watcher.status !== "running") return;
    watcher.timer = null;
    try {
      await refreshWatch({ generation, resetTimer: false });
    } catch (error) {
      if (!watcher || watcher.generation !== generation) return;
      watcher.error = error.message;
      watcher.message = `监控刷新失败：${error.message}`;
    } finally {
      scheduleNextWatchRefresh(generation);
    }
  }, delay);
}

async function refreshMarketWatch({ refreshStarted, generation, allowStarting }) {
  watcher.message = "正在全市场发现多/空信号...";
  const scanTime = new Date().toISOString();
  const catalog = await loadMarketCatalog();
  const marketSource = resolveMarketWatchMarkets(watcher.marketType, catalog);
  const eligibleMarkets = filterTradableSymbols(marketSource.markets, config.scan);
  const regime = buildMarketRegime({
    spotMarkets: catalog.spot,
    futuresMarkets: catalog.futures,
    preferredMarketType: watcher.marketType
  });
  const maxSymbols = Math.max(1, Number(config.marketWatch.maxSymbols || 80));
  const selectedMarkets = eligibleMarkets.slice(0, maxSymbols);

  if (!selectedMarkets.length) {
    const reason = marketSource.notice || "没有符合流动性和点差条件的可交易 USDT 标的。";
    if (allowStarting) throw new Error(reason);
    watcher.marketAlerts = [];
    watcher.marketScan = makeMarketScanSummary({
      scanTime,
      marketSource,
      eligibleMarkets,
      selectedMarkets,
      snapshots: [],
      rawSignals: [],
      alerts: [],
      errors: [reason]
    });
    watcher.message = reason;
    watcher.error = reason;
    return getWatchStatus();
  }

  const errors = [];
  let processed = 0;
  const snapshotGroups = await mapWithConcurrency(
    selectedMarkets,
    Math.max(1, Number(config.marketWatch.requestConcurrency || 4)),
    async (market) => {
      const snapshots = [];
      try {
        const fusedMarket = await hydrateMarketForSignal(market, catalog, regime);
        for (const interval of config.marketWatch.intervals) {
          const candles = await client.getKlines(
            fusedMarket.dataSourceMarketType || fusedMarket.marketType,
            fusedMarket.symbol,
            interval,
            config.marketWatch.klineLimit
          );
          if (candles.length >= 60) {
            snapshots.push(buildMarketSnapshot({ market: fusedMarket, interval, candles }));
          }
        }
      } catch (error) {
        errors.push(`${market.symbol}: ${error.message}`);
      } finally {
        processed += 1;
        watcher.message = `全市场扫描中 ${processed}/${selectedMarkets.length}，已发现 ${watcher.marketAlerts?.length || 0} 条候选。`;
      }
      return snapshots;
    }
  );

  if (!watcher || watcher.generation !== generation) return getWatchStatus();

  const snapshots = snapshotGroups.flat();
  const rawSignals = snapshots.flatMap(generateSignalsFromSnapshot);
  const reviewedSignals = reviewSignalsForQuality(
    rawSignals,
    snapshots,
    Math.max(Number(config.marketWatch.signalLimit || 30) * 4, 60)
  );
  const classifiedSignals = await reviewMarketSignalsWithAi(
    reviewedSignals
      .map((signal) => ({
        signal,
        classification: classifyMarketSignal(signal),
        aiAnalysis: null
      }))
      .filter((item) => item.classification.level !== "blocked")
      .sort(compareClassifiedMarketSignals)
      .slice(0, config.marketWatch.signalLimit)
  );
  const alerts = classifiedSignals.map(({ signal, classification, aiAnalysis }) => {
    const classifiedSignal = attachMarketSignalClassification(signal, classification, aiAnalysis);
    return marketSignalToAlert(classifiedSignal, scanTime, classification);
  });
  const summary = makeMarketScanSummary({
    scanTime,
    marketSource,
    eligibleMarkets,
    selectedMarkets,
    snapshots,
    rawSignals,
    alerts,
    errors
  });

  watcher.currents = {};
  watcher.errors = {};
  watcher.marketAlerts = alerts;
  watcher.marketScan = summary;
  dispatchFeishuNotifications(notifyFeishuMarketAlerts(alerts, {
    scope: "market",
    scanTime,
    scannedMarkets: selectedMarkets.length,
    eligibleMarkets: eligibleMarkets.length
  }));
  watcher.history = [
    {
      time: scanTime,
      symbol: "MARKET",
      price: null,
      action: "全市场发现",
      score: alerts[0]?.score || 0,
      message: `扫描 ${selectedMarkets.length}/${eligibleMarkets.length} 个标的，发现 ${countAlertsByLevel(alerts, "formal")} 个正式短线点、${countAlertsByLevel(alerts, "watch")} 个观察候选。`
    },
    ...watcher.history
  ].slice(0, 80);
  watcher.lastRefreshedAt = new Date().toISOString();
  watcher.lastRefreshDurationMs = Date.now() - refreshStarted;
  watcher.message = `全市场扫描完成：覆盖 ${selectedMarkets.length}/${eligibleMarkets.length} 个标的，发现 ${countAlertsByLevel(alerts, "formal")} 个正式短线点、${countAlertsByLevel(alerts, "watch")} 个观察候选。`;
  watcher.error = errors.length ? `部分币种刷新失败：${errors.slice(0, 3).join("；")}` : null;
  return getWatchStatus();
}

async function reviewMarketSignalsWithAi(items) {
  const reviewLimit = Math.max(0, Number(config.marketWatch.aiReviewLimit || 0));
  const signalLimit = Math.max(1, Number(config.marketWatch.signalLimit || 30));
  if (!config.openaiApiKey || !reviewLimit) {
    return items
      .map((item) => applyGlobalSignalGate(item, { requireAiPass: false }))
      .sort(compareClassifiedMarketSignals)
      .slice(0, signalLimit);
  }

  const reviewed = [];
  let aiReviewed = 0;
  for (const item of items) {
    if (aiReviewed >= reviewLimit || item.classification.level !== "formal") {
      reviewed.push(applyGlobalSignalGate(item, {
        requireAiPass: item.classification.level === "formal",
        extraIssue: item.classification.level === "formal" ? "该正式候选未进入 AI 复核名额，先降级观察。" : null
      }));
      continue;
    }

    try {
      const aiAnalysis = await analyzeSignal(attachMarketSignalClassification(item.signal, item.classification));
      const classification = applyAiReviewToMarketClassification(item.classification, aiAnalysis.review);
      reviewed.push(applyGlobalSignalGate({ ...item, classification, aiAnalysis }, { requireAiPass: true }));
    } catch (error) {
      reviewed.push(applyGlobalSignalGate(item, {
        requireAiPass: true,
        extraIssue: `AI 复核失败：${error.message}`
      }));
    } finally {
      aiReviewed += 1;
    }
  }

  return reviewed
    .filter((item) => item.classification.level !== "blocked")
    .sort(compareClassifiedMarketSignals)
    .slice(0, signalLimit);
}

function applyGlobalSignalGate(item, { requireAiPass = false, extraIssue = null } = {}) {
  const signal = item.aiAnalysis
    ? attachMarketSignalClassification(item.signal, item.classification, item.aiAnalysis)
    : item.signal;
  const gate = evaluateGlobalSignalFilter(signal, item.classification, { requireAiPass });
  const issues = [...gate.issues, extraIssue].filter(Boolean);
  if (gate.passed && !extraIssue) return item;
  if (item.classification.level === "blocked") return item;
  return {
    ...item,
    classification: {
      ...item.classification,
      level: "watch",
      statusLabel: "共振观察",
      isFormalShortTerm: false,
      needsConfirmation: [...issues, ...(item.classification.needsConfirmation || [])],
      classificationReason: issues[0] || item.classification.classificationReason,
      message: issues[0] || "信号未通过趋势、量能与 AI 共振门槛，降级观察。"
    }
  };
}

function resolveMarketWatchMarkets(preferredMarketType, catalog) {
  const spotMarkets = (catalog.spot || []).map((market) => withMarketSource(market, "spot"));
  const futuresMarkets = (catalog.futures || []).map((market) => withMarketSource(market, "futures"));

  if (preferredMarketType === "spot") {
    return {
      markets: spotMarkets,
      notice: catalog.spotError ? `现货行情接口异常：${catalog.spotError}` : null
    };
  }

  if (preferredMarketType === "futures") {
    if (futuresMarkets.length) {
      return {
        markets: futuresMarkets,
        notice: null
      };
    }

    return {
      markets: spotMarkets.map((market) => asFuturesProxy(market, catalog)),
      notice: catalog.futuresError
        ? `合约接口不可用，当前用现货 K 线代理发现合约多空：${catalog.futuresError}`
        : "合约市场列表为空，当前用现货 K 线代理发现合约多空。"
    };
  }

  const markets = futuresMarkets.length
    ? [...futuresMarkets, ...spotMarkets]
    : spotMarkets.map((market) => asFuturesProxy(market, catalog));
  return {
    markets,
    notice: futuresMarkets.length
      ? null
      : `合约接口不可用，自动模式使用现货 K 线代理：${catalog.futuresError || "合约市场列表为空"}`
  };
}

function marketSignalToAlert(signal, scanTime, classification = classifyMarketSignal(signal)) {
  const snapshot = signal.marketSnapshot || {};
  return {
    id: `market:${signal.symbol}:${signal.marketType}:${signal.timeframe}:${signal.direction}`,
    time: scanTime,
    symbol: signal.symbol,
    price: snapshot.price,
    action: marketSignalAction(signal, classification),
    actionHint: signal.invalidCondition,
    direction: signal.direction,
    directionLabel: signal.directionLabel,
    timeframe: signal.timeframe,
    marketType: signal.marketType,
    actualMarketType: snapshot.actualMarketType || signal.marketType,
    dataSourceMarketType: snapshot.dataSourceMarketType || signal.marketType,
    isFuturesProxy: Boolean(snapshot.isFuturesProxy),
    marketNotice: snapshot.marketNotice || null,
    fusion: snapshot.fusion || null,
    directionAnalysis: snapshot.directionAnalysis || null,
    technicalConsensus: snapshot.technicalConsensus || null,
    volumeRatio: snapshot.indicators?.volumeRatio ?? null,
    score: signal.score,
    ruleScore: signal.ruleScore,
    riskReward: signal.riskReward,
    entryRange: signal.entryRange,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    riskLevel: signal.riskLevel,
    reasons: signal.reasons || [],
    riskNotes: signal.riskNotes || [],
    quality: signal.quality,
    signalLevel: classification.level,
    statusLabel: classification.statusLabel,
    classificationReason: classification.classificationReason,
    needsConfirmation: classification.needsConfirmation || [],
    isFormalShortTerm: classification.isFormalShortTerm,
    aiSummary: signal.aiSummary || null,
    aiReview: signal.aiReview || null,
    aiSource: signal.aiSource || null,
    message: `${signal.timeframe} ${marketSignalAction(signal, classification)}，评分 ${signal.score}，RR ${signal.riskReward ?? "-"}`
  };
}

function makeMarketScanSummary({ scanTime, marketSource, eligibleMarkets, selectedMarkets, snapshots, rawSignals, alerts, errors }) {
  return {
    updatedAt: scanTime,
    requestedMarketType: watcher?.marketType || null,
    sourceMarkets: marketSource.markets.length,
    eligibleMarkets: eligibleMarkets.length,
    scannedMarkets: selectedMarkets.length,
    snapshots: snapshots.length,
    rawSignals: rawSignals.length,
    signals: alerts.length,
    formalSignals: countAlertsByLevel(alerts, "formal"),
    watchSignals: countAlertsByLevel(alerts, "watch"),
    maxSymbols: Number(config.marketWatch.maxSymbols || 80),
    notice: marketSource.notice,
    errors: errors.slice(0, 8)
  };
}

function countAlertsByLevel(alerts, level) {
  return alerts.filter((alert) => alert.signalLevel === level).length;
}

function scheduleWatchAi(symbol, baseState, updatedAt, generation) {
  if (aiInFlightBySymbol.has(symbol)) return;
  void updateWatchAi(symbol, baseState, updatedAt, generation);
}

async function updateWatchAi(symbol, baseState, updatedAt, generation) {
  aiInFlightBySymbol.add(symbol);
  try {
    const ai = await analyzeWatchState(baseState);
    if (!watcher?.currents?.[symbol]) return;
    if (!["starting", "running"].includes(watcher.status) || watcher.generation !== generation || watcher.currents[symbol].updatedAt !== updatedAt) {
      return scheduleLatestWatchAi(symbol, generation);
    }
    watcher.currents[symbol].ai = ai;
    watcher.history = [
      {
        time: new Date().toISOString(),
        symbol,
        price: watcher.currents[symbol].price,
        action: watcher.currents[symbol].alert.action,
        score: watcher.currents[symbol].alert.score,
        message: ai.summary
      },
      ...watcher.history
    ].slice(0, 80);
    watcher.message = `${symbol} AI 分析已更新：${watcher.currents[symbol].alert.action}`;
  } catch (error) {
    if (!watcher?.currents?.[symbol]) return;
    if (!["starting", "running"].includes(watcher.status) || watcher.generation !== generation || watcher.currents[symbol].updatedAt !== updatedAt) {
      return scheduleLatestWatchAi(symbol, generation);
    }
    watcher.currents[symbol].ai = {
      source: "local-rules-after-ai-error",
      summary: `AI 分析暂不可用：${error.message}`,
      action: watcher.currents[symbol].alert.action,
      checklist: watcher.currents[symbol].alert.reasons,
      risk: watcher.currents[symbol].alert.riskNotes
    };
    watcher.message = `${symbol} 规则信号已更新，AI 暂不可用。`;
  } finally {
    aiInFlightBySymbol.delete(symbol);
  }
}

function scheduleLatestWatchAi(symbol, generation) {
  const latest = watcher?.currents?.[symbol];
  if (!latest || watcher?.generation !== generation) return;
  if (latest.ai?.source !== "pending-ai") return;
  queueMicrotask(() => scheduleWatchAi(symbol, latest, latest.updatedAt, generation));
}

function pendingAi(baseState) {
  return {
    source: "pending-ai",
    summary: "AI 正在分析当前分时状态，规则信号已先显示。",
    action: baseState.alert.action,
    checklist: baseState.alert.reasons,
    risk: baseState.alert.riskNotes
  };
}

async function loadMarketCatalog() {
  const [spotResult, futuresResult] = await Promise.allSettled([
    client.getSpotSymbols(),
    client.getFuturesSymbols()
  ]);

  return {
    spot: spotResult.status === "fulfilled" ? spotResult.value : [],
    futures: futuresResult.status === "fulfilled" ? futuresResult.value : [],
    spotError: spotResult.status === "rejected" ? spotResult.reason?.message : null,
    futuresError: futuresResult.status === "rejected" ? futuresResult.reason?.message : null
  };
}

async function hydrateMarketForSignal(market, catalog, regime = null) {
  const withFusion = await hydrateFusionForSignal(market, catalog);
  return hydrateDirectionForSignal(withFusion, regime);
}

async function hydrateFusionForSignal(market, catalog) {
  if (market.marketType !== "futures" || market.isFuturesProxy) {
    return enrichMarketWithFusion({ market, catalog });
  }

  try {
    const derivatives = await client.getFuturesDerivatives(market.symbol);
    return enrichMarketWithFusion({ market, catalog, derivatives });
  } catch (error) {
    return enrichMarketWithFusion({
      market,
      catalog,
      derivatives: {
        status: "unavailable",
        fundingRate: market.fundingRate ?? null,
        errors: [error.message]
      }
    });
  }
}

async function hydrateDirectionForSignal(market, regime = null) {
  if (!config.direction.enabled) return enrichMarketWithDirection({ market, regime });
  try {
    const microstructure = await client.getMarketMicrostructure(
      market.dataSourceMarketType || market.marketType,
      market.symbol,
      {
        depthLimit: config.direction.depthLimit,
        aggTradeLimit: config.direction.aggTradeLimit
      }
    );
    return enrichMarketWithDirection({ market, microstructure, regime });
  } catch (error) {
    return enrichMarketWithDirection({
      market,
      microstructure: {
        status: "unavailable",
        errors: [error.message]
      },
      regime
    });
  }
}

function resolveMarketFromCatalog(symbol, preferredMarketType, catalog) {
  const spot = catalog.spot.find((item) => item.symbol === symbol) || null;
  const futures = catalog.futures.find((item) => item.symbol === symbol) || null;

  if (preferredMarketType === "spot") {
    if (spot) return withMarketSource(spot, "spot");
    return failSymbol(symbol, catalog, "spot");
  }

  if (preferredMarketType === "futures") {
    if (futures) return withMarketSource(futures, "futures");
    if (spot && catalog.futuresError) return asFuturesProxy(spot, catalog);
    return failSymbol(symbol, catalog, "futures");
  }

  if (preferredMarketType === "auto") {
    if (futures) return withMarketSource(futures, "futures");
    if (spot && catalog.futuresError) return asFuturesProxy(spot, catalog);
    if (spot) return withMarketSource(spot, "spot");
    return failSymbol(symbol, catalog, "auto");
  }

  if (futures) return withMarketSource(futures, "futures");
  if (spot) return asFuturesProxy(spot, catalog);
  return failSymbol(symbol, catalog, "auto");
}

function failSymbol(symbol, catalog, preferredMarketType = "auto") {
  const errors = [catalog.spotError, catalog.futuresError].filter(Boolean).join("；");
  const marketText = preferredMarketType === "spot"
    ? "现货"
    : preferredMarketType === "futures"
      ? "合约"
      : "现货或合约";
  throw new Error(errors ? `未找到可交易${marketText}币种：${symbol}（${errors}）` : `未找到可交易${marketText}币种：${symbol}`);
}

function serializeWatcher(value) {
  if (!value) return idleWatcher();
  const { timer, ...rest } = value;
  const symbols = rest.symbols || (rest.symbol ? [rest.symbol] : []);
  const items = symbols.map((symbol) => {
    const error = rest.errors?.[symbol] || null;
    const current = rest.currents?.[symbol] ? serializeCurrent(rest.currents[symbol]) : null;
    const pending = !current && (rest.isRefreshing || rest.status === "starting");
    return {
      symbol,
      current,
      error,
      pending,
      stale: Boolean(error && current),
      alerts: (rest.alerts?.[symbol] || []).slice(0, 20)
    };
  });
  const firstCurrent = items.find((item) => item.current)?.current || null;

  return {
    ...rest,
    symbol: rest.scope === "market" ? "全市场" : symbols.join(", "),
    symbols,
    items,
    current: firstCurrent,
    currents: undefined,
    timer: undefined
  };
}

function serializeCurrent(current) {
  return {
    symbol: current.symbol,
    marketType: current.marketType,
    actualMarketType: current.actualMarketType,
    dataSourceMarketType: current.dataSourceMarketType,
    isFuturesProxy: current.isFuturesProxy,
    marketNotice: current.marketNotice,
    proxyReason: current.proxyReason,
    updatedAt: current.updatedAt,
    price: current.price,
    trend: current.trend,
    indicators: current.indicators,
    indicatorState: current.indicatorState,
    technicalConsensus: current.technicalConsensus,
    supportResistance: current.supportResistance,
    fundingRate: current.fundingRate,
    derivatives: current.derivatives,
    spotContext: current.spotContext,
    futuresContext: current.futuresContext,
    fusion: current.fusion,
    directionAnalysis: current.directionAnalysis,
    line: current.line,
    alert: current.alert,
    tradePlan: current.tradePlan,
    swing: current.swing,
    position: current.position,
    rawAlert: current.rawAlert,
    ai: current.ai,
    signalReviews: (current.signalReviews || []).slice(0, 5).map((signal) => ({
      direction: signal.direction,
      directionLabel: signal.directionLabel,
      timeframe: signal.timeframe,
      ruleScore: signal.ruleScore,
      score: signal.score,
      entryRange: signal.entryRange,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      riskReward: signal.riskReward,
      riskLevel: signal.riskLevel,
      reasons: signal.reasons,
      riskNotes: signal.riskNotes,
      quality: signal.quality
    })),
    signals: (current.signals || []).slice(0, 5).map((signal) => ({
      direction: signal.direction,
      directionLabel: signal.directionLabel,
      timeframe: signal.timeframe,
      score: signal.score,
      entryRange: signal.entryRange,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      riskReward: signal.riskReward,
      riskLevel: signal.riskLevel,
      reasons: signal.reasons,
      riskNotes: signal.riskNotes
    }))
  };
}

function makeWatchEvent(current, previousAction) {
  const actionChanged = previousAction && previousAction !== current.alert.action;
  return {
    time: current.updatedAt,
    symbol: current.symbol,
    price: current.price,
    action: current.alert.action,
    score: current.alert.score,
    message: actionChanged
      ? `状态从 ${previousAction} 变为 ${current.alert.action}`
      : current.ai.summary
  };
}

function appendLifecycleAlerts(current, lifecycleEvents = []) {
  if (!watcher) return;
  const nextAlerts = lifecycleEventsToAlerts(current, lifecycleEvents);
  if (!nextAlerts.length) return [];

  const existing = watcher.alerts?.[current.symbol] || [];
  const existingIds = new Set(existing.map((alert) => alert.id));
  const uniqueAlerts = nextAlerts.filter((alert) => !existingIds.has(alert.id));
  if (!uniqueAlerts.length) return [];

  watcher.alerts = {
    ...watcher.alerts,
    [current.symbol]: [...uniqueAlerts, ...existing].slice(0, 30)
  };
  return uniqueAlerts;
}

function dispatchFeishuNotifications(promise) {
  void Promise.resolve(promise).catch((error) => {
    console.warn(`[feishu notify failed] ${error.message}`);
  });
}

function persistPaperTrade(current, position, lifecycleEvents = []) {
  if (!position?.signaledAt) return;
  const hasMaterialEvent = lifecycleEvents.some((event) => ["open_signal", "entry", "close"].includes(event.type));
  if (!hasMaterialEvent && position.status !== "closed") return;
  upsertPaperTradeFromPosition(position, {
    marketType: current.marketType || position.marketType || "spot",
    details: {
      actualMarketType: current.actualMarketType,
      dataSourceMarketType: current.dataSourceMarketType,
      isFuturesProxy: Boolean(current.isFuturesProxy),
      events: lifecycleEvents.map((event) => ({
        type: event.type,
        time: event.time,
        price: event.price,
        message: event.message
      }))
    }
  });
}

function appendSwingAlert(current, previousCurrent = null) {
  if (!watcher || !current?.swing) return;
  const previousSwing = previousCurrent?.swing || null;
  const swingAlert = makeSwingAlert(current, previousSwing);
  if (!swingAlert) return;

  const existing = watcher.alerts?.[current.symbol] || [];
  if (existing.some((alert) => alert.id === swingAlert.id)) return;

  watcher.alerts = {
    ...watcher.alerts,
    [current.symbol]: [swingAlert, ...existing].slice(0, 30)
  };
}

function makeSwingAlert(current, previousSwing = null) {
  const swing = current.swing;
  const previousAction = previousSwing?.action || "wait";
  const action = swing.action || "wait";
  if (!["buy_confirm", "low_watch", "sell_confirm", "short_confirm", "high_watch"].includes(action)) return null;
  if (previousAction === action) return null;

  const side = action === "buy_confirm" || action === "low_watch" ? swing.bottom : swing.top;
  const signalPoint = current.line?.at(-1) || {};
  const signalTime = signalPoint.time ? new Date(signalPoint.time).toISOString() : current.updatedAt;
  const signalPrice = Number.isFinite(signalPoint.price) ? signalPoint.price : current.price;
  const swingSide = action === "buy_confirm" || action === "low_watch" ? "low" : "high";
  const label = side?.label || swingActionText(action);
  const message = `${label}：${(side?.reasons || [])[0] || swing.summary || "波段位置发生变化。"}`;

  return {
    id: `${current.symbol}:swing:${action}:${minuteBucket(signalTime)}`,
    time: signalTime,
    symbol: current.symbol,
    price: signalPrice,
    action: swingActionText(action),
    actionHint: "波段提醒只表示价格进入高低波段观察区，不等于已经正式开仓。",
    direction: "wait",
    swingSide,
    swingAction: action,
    score: side?.score || 0,
    entryRange: side?.zoneRange || null,
    stopLoss: null,
    takeProfit: null,
    riskLevel: current.alert?.riskLevel || "-",
    lifecycleType: "swing",
    message
  };
}

function swingActionText(action) {
  if (action === "buy_confirm") return "波段低点买入确认";
  if (action === "low_watch") return "波段低点观察";
  if (action === "sell_confirm") return "波段高点卖出确认";
  if (action === "short_confirm") return "波段高点开空确认";
  if (action === "high_watch") return "波段高点观察";
  return "波段观察";
}

function minuteBucket(time) {
  const value = new Date(time).getTime();
  return Number.isFinite(value) ? Math.floor(value / 60000) : 0;
}

function appendSignalAlert(current, previousAction) {
  const alert = current.alert || {};
  if (!watcher || alert.direction === "wait") return;
  const existing = watcher.alerts?.[current.symbol] || [];
  const lastAlert = existing[0];
  const actionChanged = previousAction && previousAction !== alert.action;
  const firstSignal = !lastAlert;
  if (!firstSignal && !actionChanged) return;
  const signalPoint = current.line?.at(-1) || {};
  const signalTime = signalPoint.time ? new Date(signalPoint.time).toISOString() : current.updatedAt;
  const signalPrice = Number.isFinite(signalPoint.price) ? signalPoint.price : current.price;

  watcher.alerts = {
    ...watcher.alerts,
    [current.symbol]: [
      {
        id: `${current.symbol}:${signalTime}:${alert.direction}`,
        time: signalTime,
        symbol: current.symbol,
        price: signalPrice,
        action: alert.action,
        actionHint: alert.actionHint,
        direction: alert.direction,
        score: alert.score,
        entryRange: alert.entryRange,
        stopLoss: alert.stopLoss,
        takeProfit: alert.takeProfit,
        riskLevel: alert.riskLevel,
        message: actionChanged
          ? `信号从 ${previousAction} 变为 ${alert.action}`
          : `首次出现 ${alert.action} 信号`
      },
      ...existing
    ].slice(0, 30)
  };
}

function normalizeSymbols(input) {
  const raw = Array.isArray(input) ? input.join(" ") : String(input || "");
  const tokens = raw
    .toUpperCase()
    .split(/[\s,，;；|]+/)
    .map((item) => item.replace(/[-_/]/g, "").trim())
    .filter(Boolean);
  const symbols = [];
  const seen = new Set();

  for (const token of tokens) {
    const symbol = token.endsWith("USDT") ? token : `${token}USDT`;
    if (!/^[A-Z0-9]{2,30}USDT$/.test(symbol) || seen.has(symbol)) continue;
    seen.add(symbol);
    symbols.push(symbol);
    if (symbols.length >= MAX_WATCH_SYMBOLS) break;
  }

  return symbols;
}

function normalizeWatchScope({ scope, marketScope, input }) {
  if (marketScope === true || scope === "market") return "market";
  const raw = Array.isArray(input) ? input.join(" ") : String(input || "");
  const normalized = raw.trim().toUpperCase();
  if (["ALL", "*", "MARKET", "全市场", "市场"].includes(normalized)) return "market";
  return "symbols";
}

function normalizeMarketType(value) {
  return ["spot", "futures", "auto"].includes(value) ? value : "auto";
}

function normalizeRefreshSeconds(value, marketScope = false) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 10 || parsed > 300) {
    throw new Error("刷新间隔必须是 10 到 300 秒之间的整数。");
  }
  return marketScope ? Math.max(parsed, Number(config.marketWatch.minRefreshSeconds || 60)) : parsed;
}

function idleWatcher(message = "分时监控未启动。") {
  return {
    status: "idle",
    scope: "symbols",
    symbols: [],
    symbol: null,
    marketType: null,
    refreshSeconds: null,
    startedAt: null,
    message,
    current: null,
    items: [],
    marketAlerts: [],
    marketScan: null,
    history: [],
    alerts: {},
    errors: {},
    isRefreshing: false,
    lastRefreshStartedAt: null,
    lastRefreshedAt: null,
    lastRefreshDurationMs: null,
    nextRefreshAt: null,
    error: null
  };
}
