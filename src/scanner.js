import { randomUUID } from "node:crypto";
import { BinanceClient } from "./binanceClient.js";
import { config } from "./config.js";
import { buildMarketSnapshot, filterTradableSymbols, generateSignalsFromSnapshot, reviewSignalsForQuality } from "./signalEngine.js";
import { enrichSignalsWithAi } from "./aiAnalyzer.js";
import {
  applyAiReviewToMarketClassification,
  attachMarketSignalClassification,
  classifyMarketSignal,
  compareClassifiedMarketSignals,
  evaluateGlobalSignalFilter
} from "./marketSignalClassifier.js";
import { asFuturesProxy, enrichMarketWithFusion, withMarketSource } from "./marketFusion.js";
import { buildMarketRegime, enrichMarketWithDirection } from "./directionEngine.js";
import { mapWithConcurrency } from "./utils.js";
import { evaluateSignalsForSession } from "./signalEvaluator.js";
import { saveScanSession, saveSignalEvaluations } from "./store.js";
import { notifyFeishuMarketAlerts } from "./feishuNotifier.js";

const client = new BinanceClient(config.binance);

let activeScan = null;

export function getRuntimeState() {
  return {
    status: activeScan?.status || "idle",
    startedAt: activeScan?.startedAt || null,
    message: activeScan?.message || "未启动",
    progress: activeScan?.progress || idleProgress(),
    lastSessionId: activeScan?.lastSessionId || null,
    aiConfigured: Boolean(config.openaiApiKey),
    aiModel: config.openaiModel
  };
}

export function stopScan() {
  if (!activeScan || activeScan.status !== "running") {
    activeScan = {
      status: "paused",
      startedAt: null,
      message: "当前没有正在运行的扫描任务。",
      progress: idleProgress("已暂停"),
      lastSessionId: activeScan?.lastSessionId || null
    };
    return getRuntimeState();
  }

  activeScan.abortController.abort();
  activeScan.status = "paused";
  activeScan.message = "已暂停扫描。";
  activeScan.progress = idleProgress("已暂停");
  return getRuntimeState();
}

export async function runScan({ mode = "manual" } = {}) {
  if (activeScan?.status === "running") {
    return activeScan.promise;
  }

  const abortController = new AbortController();
  activeScan = {
    status: "running",
    startedAt: new Date().toISOString(),
    message: "正在扫描市场行情...",
    progress: makeProgress({
      phase: "准备扫描",
      percent: 1,
      detail: "初始化扫描任务"
    }),
    abortController,
    lastSessionId: activeScan?.lastSessionId || null
  };

  activeScan.promise = executeScan({ mode, abortController })
    .then((session) => {
      activeScan = {
        status: "idle",
        startedAt: null,
        message: `扫描完成，生成 ${session.signals.length} 条候选信号。`,
        progress: makeProgress({
          phase: "扫描完成",
          percent: 100,
          detail: `生成 ${session.signals.length} 条候选信号`
        }),
        lastSessionId: session.id
      };
      return session;
    })
    .catch((error) => {
      if (abortController.signal.aborted) {
        activeScan = {
          status: "paused",
          startedAt: null,
          message: "扫描已暂停。",
          progress: idleProgress("已暂停"),
          lastSessionId: activeScan?.lastSessionId || null
        };
        return {
          id: null,
          status: "paused",
          summary: { message: "扫描已暂停。" },
          signals: []
        };
      }

      activeScan = {
        status: "error",
        startedAt: null,
        message: error.message,
        progress: makeProgress({
          phase: "扫描失败",
          percent: activeScan?.progress?.percent || 0,
          detail: error.message
        }),
        lastSessionId: activeScan?.lastSessionId || null
      };
      throw error;
    });

  return activeScan.promise;
}

async function executeScan({ mode, abortController }) {
  const startTime = new Date().toISOString();
  updateProgress({
    phase: "获取市场列表",
    percent: 5,
    detail: "正在拉取现货和合约可交易市场"
  });
  const [spotResult, futuresResult] = await Promise.allSettled([
    client.getSpotSymbols(),
    client.getFuturesSymbols()
  ]);

  assertNotAborted(abortController);

  const marketErrors = [];
  const spotRaw = unwrapMarketResult(spotResult, "spot", marketErrors);
  const futuresRaw = unwrapMarketResult(futuresResult, "futures", marketErrors);
  if (!spotRaw.length && !futuresRaw.length) {
    throw new Error(`行情接口全部不可用：${marketErrors.map((item) => `${item.marketType} ${item.message}`).join("; ")}`);
  }

  const spotUniverse = filterTradableSymbols(spotRaw, config.scan)
    .map((market) => withMarketSource(market, "spot"));
  const futuresUniverse = futuresRaw.length
    ? filterTradableSymbols(futuresRaw, config.scan)
      .map((market) => withMarketSource(market, "futures"))
    : [];
  const regime = buildMarketRegime({
    spotMarkets: spotUniverse,
    futuresMarkets: futuresUniverse,
    preferredMarketType: "auto"
  });

  const spotMarkets = spotUniverse
    .slice(0, config.scan.topSymbolsPerMarket);
  const futuresMarkets = futuresUniverse.length
    ? futuresUniverse
      .slice(0, config.scan.topSymbolsPerMarket)
    : spotMarkets
      .slice(0, config.scan.topSymbolsPerMarket)
      .map((market) => asFuturesProxy(market, { futuresError: marketErrors.find((item) => item.marketType === "futures")?.message }));
  const markets = [...spotMarkets, ...futuresMarkets];
  updateProgress({
    phase: "筛选市场",
    percent: 15,
    current: 0,
    total: markets.length,
    detail: `现货 ${spotMarkets.length} 个，合约 ${futuresMarkets.length} 个`
  });

  let processedMarkets = 0;
  const snapshotGroups = await mapWithConcurrency(
    markets,
    config.scan.requestConcurrency,
    async (market) => {
      assertNotAborted(abortController);
      const fusedMarket = await hydrateMarketForSignal(market, { spot: spotUniverse, futures: futuresUniverse, futuresError: marketErrors.find((item) => item.marketType === "futures")?.message }, regime);
      const snapshots = [];
      for (const interval of config.scan.intervals) {
        assertNotAborted(abortController);
        const candles = await client.getKlines(fusedMarket.dataSourceMarketType || fusedMarket.marketType, fusedMarket.symbol, interval, config.scan.klineLimit);
        if (candles.length >= 60) {
          snapshots.push(buildMarketSnapshot({ market: fusedMarket, interval, candles }));
        }
      }
      processedMarkets += 1;
      updateProgress({
        phase: "拉取K线并计算指标",
        percent: 15 + Math.round((processedMarkets / Math.max(markets.length, 1)) * 45),
        current: processedMarkets,
        total: markets.length,
        detail: `已处理 ${processedMarkets}/${markets.length}：${market.symbol}`
      });
      return snapshots;
    }
  );

  assertNotAborted(abortController);

  const snapshots = snapshotGroups.flat();
  updateProgress({
    phase: "生成候选信号",
    percent: 65,
    detail: `正在从 ${snapshots.length} 组周期快照中筛选机会`
  });
  const rawSignals = snapshots.flatMap(generateSignalsFromSnapshot);
  const reviewedSignals = reviewSignalsForQuality(rawSignals, snapshots, 90);
  const rankedSignals = reviewedSignals
    .map((signal) => ({
      signal,
      classification: classifyMarketSignal(signal)
    }))
    .filter((item) => item.classification.level === "formal")
    .sort(compareClassifiedMarketSignals)
    .slice(0, 30)
    .map((item) => attachMarketSignalClassification(item.signal, item.classification));
  updateProgress({
    phase: "AI辅助分析",
    percent: 72,
    current: 0,
    total: Math.min(config.scan.maxAiSignals, rankedSignals.length),
    detail: config.openaiApiKey ? "正在调用 AI 分析 Top 候选" : "未配置 AI，使用本地规则摘要"
  });
  const aiReviewedSignals = await enrichSignalsWithAi(rankedSignals, ({ current, total, symbol, source }) => {
    updateProgress({
      phase: "AI辅助分析",
      percent: 72 + Math.round((current / Math.max(total, 1)) * 23),
      current,
      total,
      detail: `${source} 正在分析 ${current}/${total}：${symbol}`
    });
  });
  const signals = aiReviewedSignals
    .map((signal) => {
      const baseClassification = classifyMarketSignal(signal);
      const classification = applyAiReviewToMarketClassification(baseClassification, signal.aiReview);
      const gate = evaluateGlobalSignalFilter(signal, classification, { requireAiPass: Boolean(config.openaiApiKey) });
      if (!gate.passed) return null;
      return attachMarketSignalClassification(signal, classification);
    })
    .filter(Boolean);
  updateProgress({
    phase: "保存复盘记录",
    percent: 97,
    detail: "正在写入本地复盘数据库"
  });
  const endTime = new Date().toISOString();

  const session = {
    id: randomUUID(),
    startTime,
    endTime,
    mode,
    status: marketErrors.length ? "partial" : "completed",
    summary: buildSummary({ spotMarkets, futuresMarkets, snapshots, rawSignals, signals, marketErrors }),
    signals
  };

  saveScanSession(session);
  dispatchFeishuNotifications(notifyFeishuMarketAlerts(signals, {
    scope: "manual",
    scanTime: endTime,
    scannedMarkets: markets.length,
    eligibleMarkets: markets.length
  }));
  await refreshEvaluationsForSession(session);
  return session;
}

function dispatchFeishuNotifications(promise) {
  void Promise.resolve(promise).catch((error) => {
    console.warn(`[feishu notify failed] ${error.message}`);
  });
}

export async function refreshEvaluationsForSession(session) {
  if (!session?.signals?.length) return [];
  const evaluations = await evaluateSignalsForSession({ session, client });
  saveSignalEvaluations(session.id, evaluations);
  return evaluations;
}

function unwrapMarketResult(result, marketType, marketErrors) {
  if (result.status === "fulfilled") return result.value;
  marketErrors.push({
    marketType,
    message: result.reason?.message || "unknown error"
  });
  return [];
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

function buildSummary({ spotMarkets, futuresMarkets, snapshots, rawSignals, signals, marketErrors }) {
  const byDirection = signals.reduce((acc, signal) => {
    acc[signal.direction] = (acc[signal.direction] || 0) + 1;
    return acc;
  }, {});

  return {
    spotScanned: spotMarkets.length,
    futuresScanned: futuresMarkets.length,
    snapshots: snapshots.length,
    rawSignals: rawSignals.length,
    filteredSignals: Math.max(0, rawSignals.length - signals.length),
    signals: signals.length,
    byDirection,
    aiEnabled: Boolean(config.openaiApiKey),
    aiModel: config.openaiModel,
    marketErrors,
    note: "信号已按趋势、量能、盈亏比、衍生品融合和 AI 复核进行过滤。"
  };
}

function assertNotAborted(abortController) {
  if (abortController.signal.aborted) {
    throw new Error("Scan aborted");
  }
}

function updateProgress(progress) {
  if (!activeScan) return;
  activeScan.progress = makeProgress(progress);
  activeScan.message = progress.detail || progress.phase || activeScan.message;
}

function makeProgress({ phase, percent, current = null, total = null, detail = "" } = {}) {
  return {
    phase: phase || "未启动",
    percent: Math.max(0, Math.min(100, Math.round(percent || 0))),
    current,
    total,
    detail
  };
}

function idleProgress(phase = "未启动") {
  return makeProgress({ phase, percent: 0, detail: phase });
}
