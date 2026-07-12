import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BinanceClient } from "../src/binanceClient.js";
import { config } from "../src/config.js";
import { buildMarketRegime, enrichMarketWithDirection } from "../src/directionEngine.js";
import { buildFormalSafetyFailures, updateSignalConfirmations } from "../src/formalSignalRules.js";
import { buildMarketSnapshot, filterTradableSymbols, generateSignalsFromSnapshot, reviewSignalsForQuality } from "../src/signalEngine.js";
import { withMarketSource } from "../src/marketFusion.js";
import {
  activeRiskGuard,
  buildPositionRiskPlan,
  calculatePortfolioRiskMetrics,
  nextUtcDayIso,
  portfolioEntryBlockers,
  realizedAccountReturnPercent
} from "../src/portfolioRisk.js";
import { isFeishuEnabled, sendFeishuText } from "../src/feishuNotifier.js";
import { summarizePerformance } from "../src/tradeMetrics.js";
import { clamp, mapWithConcurrency, round, safeJsonParse, sleep } from "../src/utils.js";
import { atomicWriteJson, sessionDateKey, sessionFileName } from "../src/monitorPersistence.js";

const client = new BinanceClient(config.binance);
const defaultMaxChase24hPercent = readNumber("FORMAL_MONITOR_MAX_CHASE_24H_PERCENT", 18);
const defaultShadowProfiles = "balanced:minEdge=30,minNetTargetPercent=0.12;strict:minEdge=35,minNetTargetPercent=0.15";
const defaultConfirmationIntervals = "1d";
const monitorTimeframeWeight = { "1m": 1, "5m": 2, "15m": 3, "1h": 4, "4h": 5, "1d": 6 };
const hardSafetyFailures = new Set(["chase24h", "volatility", "spread", "net_target", "reward_risk", "timeframe_conflict"]);
const softSignalFailures = new Set(["edge", "score", "technical", "volume", "source_quality", "entry_quality", "timeframe_confirmation"]);
const CONSECUTIVE_STOP_PAUSE_MS = 2 * 60 * 60 * 1000;
const CONSECUTIVE_STOP_TRIGGER = 3;
const pendingFeishuNotifications = new Set();
let shutdownInProgress = false;

const options = {
  // 0 means continuous operation; daily reporting is rotated independently.
  durationSeconds: readInt("FORMAL_MONITOR_DURATION_SECONDS", 0),
  timeZone: process.env.FORMAL_MONITOR_TIMEZONE || "Asia/Shanghai",
  scanSeconds: readInt("FORMAL_MONITOR_SCAN_SECONDS", 180),
  pollSeconds: readInt("FORMAL_MONITOR_POLL_SECONDS", 20),
  scalpPollSeconds: readInt("FORMAL_MONITOR_SCALP_POLL_SECONDS", 5),
  symbolLimit: readInt("FORMAL_MONITOR_SYMBOL_LIMIT", 24),
  maxOpenPositions: readInt("FORMAL_MONITOR_MAX_OPEN", 6),
  maxTotalTrades: readInt("FORMAL_MONITOR_MAX_TRADES", 80),
  accountRiskPerTradePercent: readNumber("FORMAL_MONITOR_ACCOUNT_RISK_PER_TRADE_PERCENT", 0.5),
  maxPortfolioRiskPercent: readNumber("FORMAL_MONITOR_MAX_PORTFOLIO_RISK_PERCENT", 2),
  maxSameSideOpen: readInt("FORMAL_MONITOR_MAX_SAME_SIDE_OPEN", 3),
  maxPositionSizePercentOfEquity: readNumber("FORMAL_MONITOR_MAX_POSITION_SIZE_PERCENT", 35),
  maxPortfolioPositionSizePercentOfEquity: readNumber("FORMAL_MONITOR_MAX_PORTFOLIO_POSITION_SIZE_PERCENT", 100),
  maxSessionDrawdownPercent: readNumber("FORMAL_MONITOR_MAX_SESSION_DRAWDOWN_PERCENT", 8),
  maxDailyLossPercent: readNumber("FORMAL_MONITOR_MAX_DAILY_LOSS_PERCENT", 3),
  signalInterval: process.env.FORMAL_MONITOR_SIGNAL_INTERVAL || "4h",
  sourceSignalInterval: process.env.FORMAL_MONITOR_SOURCE_SIGNAL_INTERVAL || "1h",
  confirmationIntervals: parseCsvList(process.env.FORMAL_MONITOR_CONFIRMATION_INTERVALS || defaultConfirmationIntervals),
  klineLimit: readInt("FORMAL_MONITOR_KLINE_LIMIT", 120),
  minEdge: readNumber("FORMAL_MONITOR_MIN_EDGE", 25),
  minScore: readNumber("FORMAL_MONITOR_MIN_SCORE", 72),
  minVolumeRatio: readNumber("FORMAL_MONITOR_MIN_VOLUME_RATIO", 0.45),
  executionMinScore: readNumber("FORMAL_MONITOR_EXECUTION_MIN_SCORE", 76),
  executionMinEdge: readNumber("FORMAL_MONITOR_EXECUTION_MIN_EDGE", 18),
  executionMaxSoftFailures: readInt("FORMAL_MONITOR_EXECUTION_MAX_SOFT_FAILURES", 1),
  filteredSourceMinScore: readNumber("FORMAL_MONITOR_FILTERED_SOURCE_MIN_SCORE", 70),
  formalRequireEntryQuality: readBoolean("FORMAL_MONITOR_REQUIRE_ENTRY_QUALITY", true),
  momentumEntryEnabled: readBoolean("FORMAL_MONITOR_MOMENTUM_ENTRY_ENABLED", true),
  momentumMinScore: readNumber("FORMAL_MONITOR_MOMENTUM_MIN_SCORE", 84),
  momentumMinEdge: readNumber("FORMAL_MONITOR_MOMENTUM_MIN_EDGE", 28),
  momentumMinVolumeRatio: readNumber("FORMAL_MONITOR_MOMENTUM_MIN_VOLUME_RATIO", 1.05),
  momentumMinLiveMovePercent: readNumber("FORMAL_MONITOR_MOMENTUM_MIN_LIVE_MOVE_PERCENT", 0.28),
  momentumMinClosedMovePercent: readNumber("FORMAL_MONITOR_MOMENTUM_MIN_CLOSED_MOVE_PERCENT", 0.24),
  momentumMaxLongChase24hPercent: readNumber("FORMAL_MONITOR_MOMENTUM_MAX_LONG_CHASE_24H_PERCENT", 9),
  momentumMaxShortChase24hPercent: readNumber("FORMAL_MONITOR_MOMENTUM_MAX_SHORT_CHASE_24H_PERCENT", 9),
  momentumMaxSoftFailures: readInt("FORMAL_MONITOR_MOMENTUM_MAX_SOFT_FAILURES", 2),
  scalpMaxHoldMinutes: readNumber("FORMAL_MONITOR_SCALP_MAX_HOLD_MINUTES", 25),
  scalpAlertMaxCandidates: readInt("FORMAL_MONITOR_SCALP_ALERT_MAX_CANDIDATES", 16),
  scalpAlertMinMovePercent: readNumber("FORMAL_MONITOR_SCALP_ALERT_MIN_MOVE_PERCENT", 0.18),
  scalpAlertMinVolumeRatio: readNumber("FORMAL_MONITOR_SCALP_ALERT_MIN_VOLUME_RATIO", 1.2),
  scalpAlertMinEdge: readNumber("FORMAL_MONITOR_SCALP_ALERT_MIN_EDGE", 12),
  scalpDecisionMinScore: readNumber("FORMAL_MONITOR_SCALP_DECISION_MIN_SCORE", 80),
  scalpDecisionMinEdge: readNumber("FORMAL_MONITOR_SCALP_DECISION_MIN_EDGE", 22),
  scalpDecisionMinVolumeRatio: readNumber("FORMAL_MONITOR_SCALP_DECISION_MIN_VOLUME_RATIO", 1.05),
  scalpTargetPercent: readNumber("FORMAL_MONITOR_SCALP_TARGET_PERCENT", 0.32),
  scalpStopPercent: readNumber("FORMAL_MONITOR_SCALP_STOP_PERCENT", 0.24),
  scalpMinNetTargetPercent: readNumber("FORMAL_MONITOR_SCALP_MIN_NET_TARGET_PERCENT", 0.08),
  scalpMinRewardRisk: readNumber("FORMAL_MONITOR_SCALP_MIN_REWARD_RISK", 0.95),
  scalpAllowNoSourceMicrostructure: readBoolean("FORMAL_MONITOR_SCALP_ALLOW_NO_SOURCE_MICROSTRUCTURE", true),
  scalpNoSourceHighEdge: readNumber("FORMAL_MONITOR_SCALP_NO_SOURCE_HIGH_EDGE", 30),
  scalpNoSourceHighEdgeMinVolumeRatio: readNumber("FORMAL_MONITOR_SCALP_NO_SOURCE_HIGH_EDGE_MIN_VOLUME_RATIO", 0.9),
  scalpNoSourceMediumEdge: readNumber("FORMAL_MONITOR_SCALP_NO_SOURCE_MEDIUM_EDGE", 26),
  scalpNoSourceMediumEdgeMinVolumeRatio: readNumber("FORMAL_MONITOR_SCALP_NO_SOURCE_MEDIUM_EDGE_MIN_VOLUME_RATIO", 1.2),
  scalpNoSourceMinClosedMovePercent: readNumber("FORMAL_MONITOR_SCALP_NO_SOURCE_MIN_CLOSED_MOVE_PERCENT", 0.18),
  scalpNoSourceMaxLiveMovePercent: readNumber("FORMAL_MONITOR_SCALP_NO_SOURCE_MAX_LIVE_MOVE_PERCENT", 0.18),
  scalpNoSourceMaxClosedMovePercent: readNumber("FORMAL_MONITOR_SCALP_NO_SOURCE_MAX_CLOSED_MOVE_PERCENT", 0.55),
  scalpConfirmationScans: readInt("FORMAL_MONITOR_SCALP_CONFIRMATION_SCANS", 1),
  opportunityHistoryMaxItems: readInt("FORMAL_MONITOR_OPPORTUNITY_HISTORY_MAX_ITEMS", 1200),
  watchlistMaxCandidates: readInt("FORMAL_MONITOR_WATCHLIST_MAX_CANDIDATES", 16),
  watchlistMinScore: readNumber("FORMAL_MONITOR_WATCHLIST_MIN_SCORE", 74),
  watchlistMinEdge: readNumber("FORMAL_MONITOR_WATCHLIST_MIN_EDGE", 16),
  edgeContradiction: readNumber("FORMAL_MONITOR_EDGE_CONTRADICTION", Number(config.direction?.contradictionEdge || 25)),
  confirmationScans: readInt("FORMAL_MONITOR_CONFIRMATION_SCANS", 2),
  confirmationStaleScans: readInt("FORMAL_MONITOR_CONFIRMATION_STALE_SCANS", 3),
  confirmationMode: readEnum("FORMAL_MONITOR_CONFIRMATION_MODE", ["recent", "consecutive"], "recent"),
  cooldownMinutes: readInt("FORMAL_MONITOR_COOLDOWN_MINUTES", 60),
  maxChase24hPercent: defaultMaxChase24hPercent,
  maxLongChase24hPercent: readNumber("FORMAL_MONITOR_MAX_LONG_CHASE_24H_PERCENT", 12),
  maxShortChase24hPercent: readNumber("FORMAL_MONITOR_MAX_SHORT_CHASE_24H_PERCENT", defaultMaxChase24hPercent),
  maxAtrPercent: readNumber("FORMAL_MONITOR_MAX_ATR_PERCENT", 2),
  maxFormalSpreadPercent: readNumber("FORMAL_MONITOR_MAX_SPREAD_PERCENT", 0.08),
  minNetTargetPercent: readNumber("FORMAL_MONITOR_MIN_NET_TARGET_PERCENT", 0.12),
  minRewardRisk: readNumber("FORMAL_MONITOR_MIN_REWARD_RISK", 1.15),
  minTargetPercent: readNumber("FORMAL_MONITOR_MIN_TARGET_PERCENT", 0.35),
  maxTargetPercent: readNumber("FORMAL_MONITOR_MAX_TARGET_PERCENT", 1.2),
  minStopPercent: readNumber("FORMAL_MONITOR_MIN_STOP_PERCENT", 0.25),
  maxStopPercent: readNumber("FORMAL_MONITOR_MAX_STOP_PERCENT", 0.85),
  targetAtrFraction: readNumber("FORMAL_MONITOR_TARGET_ATR_FRACTION", 0.85),
  stopAtrFraction: readNumber("FORMAL_MONITOR_STOP_ATR_FRACTION", 0.62),
  requestConcurrency: readInt("FORMAL_MONITOR_REQUEST_CONCURRENCY", 4),
  aiEnabled: readBoolean("FORMAL_MONITOR_AI_ENABLED", Boolean(config.openaiApiKey)),
  aiRequired: readBoolean("FORMAL_MONITOR_AI_REQUIRED", Boolean(config.openaiApiKey)),
  aiMaxCandidatesPerScan: readInt("FORMAL_MONITOR_AI_MAX_CANDIDATES", 6),
  aiMinConfidence: readNumber("FORMAL_MONITOR_AI_MIN_CONFIDENCE", 0.75),
  watchEnabled: readBoolean("FORMAL_MONITOR_WATCH_ENABLED", true),
  watchMaxCandidates: readInt("FORMAL_MONITOR_WATCH_MAX_CANDIDATES", 12),
  watchMaxFailures: readInt("FORMAL_MONITOR_WATCH_MAX_FAILURES", 3),
  watchMinScore: readNumber("FORMAL_MONITOR_WATCH_MIN_SCORE", 68),
  watchMinEdge: readNumber("FORMAL_MONITOR_WATCH_MIN_EDGE", 18),
  shadowProfiles: parseShadowProfiles(process.env.FORMAL_MONITOR_SHADOW_PROFILES ?? defaultShadowProfiles),
  shadowAiEnabled: readBoolean("FORMAL_MONITOR_SHADOW_AI_ENABLED", false),
  shadowAiMaxCandidatesPerScan: readInt("FORMAL_MONITOR_SHADOW_AI_MAX_CANDIDATES", 2)
};

const startedAt = new Date().toISOString();
const outputDir = process.env.FORMAL_MONITOR_OUTPUT_DIR || join(process.cwd(), "data", "formal-signal-monitor");
mkdirSync(outputDir, { recursive: true });
const initialSessionDate = sessionDateKey(new Date(), options.timeZone);
const outputPath = join(outputDir, sessionFileName(initialSessionDate));
const latestPath = join(outputDir, "latest.json");
const runtimePath = join(outputDir, "runtime.json");

const state = {
  mode: "formal_signal_spot_price_as_futures_proxy",
  persistenceVersion: 1,
  sessionDate: initialSessionDate,
  startedAt,
  finishedAt: null,
  outputPath,
  options,
  status: "running",
  lastScanAt: null,
  nextScanAt: null,
  scanCount: 0,
  errors: [],
  ai: {
    enabled: options.aiEnabled,
    required: options.aiRequired,
    model: config.openaiModel,
    reviewed: 0,
    passed: 0,
    rejected: 0,
    errors: 0
  },
  shadowAi: {
    enabled: options.shadowAiEnabled,
    reviewed: 0,
    passed: 0,
    rejected: 0,
    errors: 0,
    lastReviews: []
  },
  marketRegime: null,
  universe: {
    eligibleSpotMarkets: 0,
    analyzedMarkets: 0,
    candidateCount: 0,
    rawCandidateCount: 0,
    preAiCandidateCount: 0,
    formalCandidateCount: 0,
    tradeCandidateCount: 0,
    scalpAlertCount: 0,
    scalpCandidateCount: 0,
    watchlistCandidateCount: 0,
    watchCandidateCount: 0,
    confirmationReadyCount: 0,
    filterDiagnostics: {
      evaluated: 0,
      accepted: 0,
      rejected: 0,
      failCounts: {}
    },
    tierDiagnostics: {},
    watchDiagnostics: {
      evaluated: 0,
      accepted: 0,
      rejected: 0,
      failCounts: {}
    },
    confirmationDiagnostics: {
      tracked: 0,
      evaluated: 0,
      ready: 0,
      pending: 0,
      requiredScans: options.confirmationScans,
      staleScans: options.confirmationStaleScans,
      consecutiveOnly: options.confirmationMode === "consecutive"
    },
    lastCandidates: [],
    lastPendingCandidates: [],
    lastFormalCandidates: [],
    lastTradeCandidates: [],
    lastScalpAlerts: [],
    lastScalpCandidates: [],
    lastWatchlistCandidates: [],
    lastWatchCandidates: [],
    lastRejectedCandidates: [],
    lastNearPassCandidates: [],
    shadowProfiles: {},
    timeframePlan: null
  },
  diagnostics: {
    aggregate: createAggregateDiagnostics("baseline"),
    shadowProfiles: Object.fromEntries(
      options.shadowProfiles.map((profile) => [profile.name, createAggregateDiagnostics(profile.name)])
    )
  },
  opportunityHistory: {
    scalpAlerts: [],
    scalpCandidates: [],
    watchlistCandidates: [],
    aiReviews: []
  },
  signalConfirmations: {},
  riskGuard: {
    consecutiveStopPauseUntil: null,
    dailyLossPauseUntil: null,
    sessionHaltedAt: null,
    sessionMaxDrawdownPercent: 0,
    entryBlockCounts: {},
    lastBlockedCandidates: [],
    pauseEvents: []
  },
  positions: [],
  trades: [],
  summary: summarizeTrades([])
};

restoreRuntimeState();
rotateSessionIfNeeded();
installShutdownCheckpoint();

console.log(`[formal-monitor] start ${startedAt}`);
console.log(`[formal-monitor] output ${outputPath}`);
console.log(`[formal-monitor] options ${JSON.stringify(options)}`);

await runMonitor();
console.log(JSON.stringify(state, null, 2));

async function runMonitor() {
  const deadline = options.durationSeconds > 0
    ? Date.now() + options.durationSeconds * 1000
    : Number.POSITIVE_INFINITY;
  let nextScanAt = 0;
  persistState();

  while (Date.now() < deadline) {
    rotateSessionIfNeeded();
    if (Date.now() >= nextScanAt && state.trades.length < options.maxTotalTrades) {
      await scanAndOpen();
      nextScanAt = Date.now() + options.scanSeconds * 1000;
      state.nextScanAt = new Date(nextScanAt).toISOString();
    }

    if (state.positions.length) {
      await pollOpenPositions();
    }

    persistState();
    await sleep(nextLoopSleepSeconds(deadline) * 1000);
  }

  if (state.positions.length) {
    await closeAllOpenPositions("timeout");
  }

  await flushPendingFeishuNotifications();
  state.status = "completed";
  state.finishedAt = new Date().toISOString();
  state.summary = summarizeTrades(state.trades);
  persistState();
}

function nextLoopSleepSeconds(deadline) {
  const remaining = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
  const hasScalpPosition = state.positions.some((position) => position.tradeStyle === "scalp_momentum");
  const configured = hasScalpPosition
    ? Math.min(options.pollSeconds, Math.max(1, options.scalpPollSeconds))
    : options.pollSeconds;
  return Math.min(Math.max(1, configured), remaining);
}

async function scanAndOpen() {
  state.scanCount += 1;
  state.lastScanAt = new Date().toISOString();

  try {
    const setup = await buildFormalCandidates();
    updateAggregateDiagnostics(state.diagnostics.aggregate, setup.evaluatedCandidates);
    for (const [name, candidates] of Object.entries(setup.shadowProfiles)) {
      if (!state.diagnostics.shadowProfiles[name]) {
        state.diagnostics.shadowProfiles[name] = createAggregateDiagnostics(name);
      }
      updateAggregateDiagnostics(state.diagnostics.shadowProfiles[name], candidates);
    }
    appendOpportunityHistory({
      scan: state.scanCount,
      seenAt: state.lastScanAt,
      scalpAlerts: setup.scalpAlerts,
      scalpCandidates: setup.scalpCandidates,
      watchlistCandidates: setup.watchlistCandidates
    });
    const confirmation = updateLayeredConfirmations(setup.candidates, state.scanCount, state.lastScanAt);
    state.signalConfirmations = confirmation.confirmations;
    const reviewedCandidates = await reviewCandidatesWithAi(confirmation.readyCandidates);
    await reviewShadowCandidatesWithAi(setup.watchCandidates.length ? setup.watchCandidates : setup.nearPassCandidates);
    state.marketRegime = setup.regime;
    state.universe = {
      eligibleSpotMarkets: setup.eligibleSpotMarkets,
      analyzedMarkets: setup.analyzedMarkets,
      timeframePlan: setup.timeframePlan,
      rawCandidateCount: setup.rawCandidateCount,
      preAiCandidateCount: setup.candidates.length,
      formalCandidateCount: setup.formalCandidates.length,
      tradeCandidateCount: setup.tradeCandidates.length,
      scalpAlertCount: setup.scalpAlerts.length,
      scalpCandidateCount: setup.scalpCandidates.length,
      watchlistCandidateCount: setup.watchlistCandidates.length,
      watchCandidateCount: setup.watchCandidates.length,
      confirmationReadyCount: confirmation.readyCandidates.length,
      candidateCount: reviewedCandidates.length,
      filterDiagnostics: setup.filterDiagnostics,
      tierDiagnostics: setup.tierDiagnostics,
      watchDiagnostics: setup.watchDiagnostics,
      confirmationDiagnostics: confirmation.diagnostics,
      lastCandidates: reviewedCandidates.slice(0, 10).map(compactCandidate),
      lastPendingCandidates: confirmation.pendingCandidates.slice(0, 10).map(compactCandidate),
      lastFormalCandidates: setup.formalCandidates.slice(0, 10).map(compactCandidate),
      lastTradeCandidates: setup.tradeCandidates.slice(0, 10).map(compactCandidate),
      lastScalpAlerts: setup.scalpAlerts.slice(0, 10).map(compactCandidate),
      lastScalpCandidates: setup.scalpCandidates.slice(0, 10).map(compactCandidate),
      lastWatchlistCandidates: setup.watchlistCandidates.slice(0, 10).map(compactCandidate),
      lastWatchCandidates: setup.watchCandidates.slice(0, 10).map(compactCandidate),
      lastRejectedCandidates: setup.rejectedCandidates.slice(0, 10).map(compactCandidate),
      lastNearPassCandidates: setup.nearPassCandidates.slice(0, 10).map(compactCandidate),
      shadowProfiles: Object.fromEntries(
        Object.entries(setup.shadowProfiles).map(([name, candidates]) => [
          name,
          {
            profile: resolveRiskProfile(options.shadowProfiles.find((profile) => profile.name === name)),
            filterDiagnostics: summarizeCandidateFilters(candidates),
            nearPassCandidates: candidates
              .filter((candidate) => !candidate.accepted)
              .sort(compareNearPassCandidates)
              .slice(0, 10)
              .map(compactCandidate)
          }
        ])
      )
    };

    const candidatesForOpening = reviewedCandidates
      .filter((candidate) => !hasOpenPosition(candidate.symbol))
      .filter((candidate) => !isCoolingDown(candidate));

    const riskPaused = isRiskGuardPaused();
    if (riskPaused) {
      state.riskGuard.lastBlockedCandidates = candidatesForOpening.slice(0, 10).map((candidate) => ({
        symbol: candidate.symbol,
        side: candidate.side,
        blockers: [riskPaused.reason]
      }));
      const resumeText = riskPaused.resumeAt || "session_end";
      console.log(`[formal-monitor][risk-guard] OBSERVE_ONLY scan=${state.scanCount} resume=${resumeText} reason=${riskPaused.reason}`);
    }

    for (const candidate of riskPaused ? [] : candidatesForOpening) {
      if (state.positions.length >= options.maxOpenPositions) break;
      const riskPlan = buildPositionRiskPlan(candidate, options);
      const blockers = portfolioEntryBlockers({
        positions: state.positions,
        candidate,
        candidateRiskPlan: riskPlan,
        accountRiskPerTradePercent: options.accountRiskPerTradePercent,
        maxPortfolioRiskPercent: options.maxPortfolioRiskPercent,
        maxSameSideOpen: options.maxSameSideOpen,
        maxPortfolioPositionSizePercentOfEquity: options.maxPortfolioPositionSizePercentOfEquity
      });
      if (blockers.length) {
        recordEntryBlocks(candidate, blockers);
        continue;
      }
      const position = await openPosition(candidate, riskPlan);
      state.positions.push(position);
      state.trades.push(position);
      console.log(`[formal-monitor] OPEN ${position.side.toUpperCase()} ${position.symbol} action=${position.actionPlan?.open || position.side} style=${position.tradeStyle || "formal"} entry=${position.entryPrice} tp=${position.takeProfit} stop=${position.stopLoss} edge=${position.directionEdge} score=${position.score}`);
      queueFormalMonitorFeishuNotification("entry", position);
    }

    console.log(`[formal-monitor] scan=${state.scanCount} candidates=${reviewedCandidates.length} confirmed=${confirmation.readyCandidates.length} pending=${confirmation.pendingCandidates.length} scalpAlerts=${setup.scalpAlerts.length} scalpCandidates=${setup.scalpCandidates.length} watchlist=${setup.watchlistCandidates.length} watch=${setup.watchCandidates.length} open=${state.positions.length} closed=${closedTrades().length}`);
  } catch (error) {
    recordError("scan", error);
  }
}

async function reviewCandidatesWithAi(candidates) {
  if (!options.aiEnabled) {
    return candidates.map((candidate) => ({
      ...candidate,
      aiReview: {
        source: "disabled",
        decision: "pass",
        confidence: 1,
        reason: "AI review disabled for this monitor run."
      }
    })).map((candidate) => {
      appendAiReviewHistory(candidate, candidate.aiReview, true);
      return candidate;
    });
  }

  if (!config.openaiApiKey) {
    state.ai.errors += 1;
    recordError("ai", new Error("OPENAI_API_KEY is not configured; continuing without AI gate."));
    return options.aiRequired ? [] : candidates;
  }

  const selected = candidates.slice(0, options.aiMaxCandidatesPerScan);
  const reviewed = [];
  for (const candidate of selected) {
    const aiReview = await analyzeCandidateWithAi(candidate);
    state.ai.reviewed += 1;
    const passed = aiReview.decision === "pass" && aiReview.confidence >= options.aiMinConfidence;
    appendAiReviewHistory(candidate, aiReview, passed);
    if (passed) {
      state.ai.passed += 1;
      reviewed.push({ ...candidate, aiReview });
    } else {
      state.ai.rejected += 1;
      if (!options.aiRequired) reviewed.push({ ...candidate, aiReview });
    }
  }
  return reviewed;
}

function updateLayeredConfirmations(candidates, scanCount, nowIso) {
  const scalpCandidates = (candidates || []).filter(hasScalpEntry);
  const formalCandidates = (candidates || []).filter((candidate) => !hasScalpEntry(candidate));
  const common = {
    scanCount,
    staleScans: options.confirmationStaleScans,
    consecutiveOnly: options.confirmationMode === "consecutive",
    nowIso
  };
  const scalp = updateSignalConfirmations(state.signalConfirmations, scalpCandidates, {
    ...common,
    requiredScans: options.scalpConfirmationScans
  });
  const formal = updateSignalConfirmations(scalp.confirmations, formalCandidates, {
    ...common,
    requiredScans: options.confirmationScans
  });
  return {
    confirmations: formal.confirmations,
    candidates: [...scalp.candidates, ...formal.candidates],
    readyCandidates: [...scalp.readyCandidates, ...formal.readyCandidates],
    pendingCandidates: [...scalp.pendingCandidates, ...formal.pendingCandidates],
    diagnostics: {
      tracked: Object.keys(formal.confirmations).length,
      evaluated: scalp.diagnostics.evaluated + formal.diagnostics.evaluated,
      ready: scalp.diagnostics.ready + formal.diagnostics.ready,
      pending: scalp.diagnostics.pending + formal.diagnostics.pending,
      requiredScans: options.confirmationScans,
      scalpRequiredScans: options.scalpConfirmationScans,
      formalRequiredScans: options.confirmationScans,
      scalpEvaluated: scalp.diagnostics.evaluated,
      scalpReady: scalp.diagnostics.ready,
      scalpPending: scalp.diagnostics.pending,
      formalEvaluated: formal.diagnostics.evaluated,
      formalReady: formal.diagnostics.ready,
      formalPending: formal.diagnostics.pending,
      staleScans: options.confirmationStaleScans,
      consecutiveOnly: options.confirmationMode === "consecutive"
    }
  };
}

function appendOpportunityHistory({ scan, seenAt, scalpAlerts = [], scalpCandidates = [], watchlistCandidates = [] }) {
  appendHistoryItems("scalpAlerts", scan, seenAt, scalpAlerts);
  appendHistoryItems("scalpCandidates", scan, seenAt, scalpCandidates);
  appendHistoryItems("watchlistCandidates", scan, seenAt, watchlistCandidates);
}

function appendHistoryItems(key, scan, seenAt, candidates = []) {
  const current = state.opportunityHistory[key] || [];
  const items = candidates.map((candidate) => ({
    scan,
    seenAt,
    ...compactCandidate(candidate)
  }));
  state.opportunityHistory[key] = [...current, ...items].slice(-Math.max(1, options.opportunityHistoryMaxItems));
}

function appendAiReviewHistory(candidate, aiReview, passed) {
  const current = state.opportunityHistory.aiReviews || [];
  const item = {
    scan: state.scanCount,
    reviewedAt: new Date().toISOString(),
    aiGatePassed: Boolean(passed),
    ...compactCandidate({ ...candidate, aiReview })
  };
  state.opportunityHistory.aiReviews = [...current, item].slice(-Math.max(1, options.opportunityHistoryMaxItems));
}

async function analyzeCandidateWithAi(candidate) {
  try {
    return await requestAiReview(candidate);
  } catch (error) {
    state.ai.errors += 1;
    recordError("ai", error, { symbol: candidate.symbol });
    return {
      source: "ai-error",
      decision: options.aiRequired ? "reject" : "watch",
      confidence: 0,
      reason: error.message
    };
  }
}

async function reviewShadowCandidatesWithAi(candidates = []) {
  if (!options.shadowAiEnabled || !options.aiEnabled || !config.openaiApiKey) return;

  const selected = candidates
    .filter((candidate) => !candidate.accepted)
    .slice(0, options.shadowAiMaxCandidatesPerScan);
  const reviews = [];

  for (const candidate of selected) {
    try {
      const aiReview = await requestAiReview(candidate);
      state.shadowAi.reviewed += 1;
      if (aiReview.decision === "pass" && aiReview.confidence >= options.aiMinConfidence) {
        state.shadowAi.passed += 1;
      } else {
        state.shadowAi.rejected += 1;
      }
      reviews.push({
        symbol: candidate.symbol,
        side: candidate.side,
        filterFailures: candidate.filterFailures,
        margins: candidate.margins,
        aiReview
      });
    } catch (error) {
      state.shadowAi.errors += 1;
      recordError("shadow_ai", error, { symbol: candidate.symbol });
    }
  }

  state.shadowAi.lastReviews = [...reviews, ...state.shadowAi.lastReviews].slice(0, 20);
}

async function requestAiReview(candidate) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(config.openaiResponsesUrl || `${config.openaiBaseUrl}/responses`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${config.openaiApiKey}`
      },
      body: JSON.stringify({
        model: config.openaiModel,
        instructions: [
          "You review paper-trading crypto signal candidates.",
          "Only return pass when directional edge, order flow, technical alignment, volume, spread, and target/stop structure are all reasonable after fees and slippage.",
          "Candidates use opportunityLayer: scalp_alert means anomaly radar only, scalp_decision means ultra-short actionable review, watchlist means slower potential setup.",
          "Never pass a scalp_alert-only candidate unless its scalpDecisionProfile.qualified is true.",
          "Some candidates may be marked as short-term momentum breakout candidates. Treat source_quality warnings as reviewable only when momentumProfile.qualified is true, higher timeframes do not hard-conflict, and the live/closed candle move has credible volume.",
          "Reject formal candidates when sourceSignal is missing and the candidate side technicalConsensus is not strong, unless momentumProfile.qualified is true.",
          `For scalp_momentum candidates, review them as ultra-short long/short opportunities with max hold about ${options.scalpMaxHoldMinutes} minutes and reject if the move already looks exhausted.`,
          "Return watch or reject when the setup narrowly passes, conflicts with live direction, has weak volume, poor net target, high chase risk, high volatility, or wide spread.",
          "Output strict JSON with decision pass/watch/reject, confidence between 0 and 1, and a short reason."
        ].join("\n"),
        input: JSON.stringify({
          task: "formal_signal_paper_trade_ai_gate",
          candidate: compactCandidate(candidate),
          costModel: estimateFormalRoundTripCost(),
          monitorRules: resolveRiskProfile()
        }),
        text: {
          format: {
            type: "json_schema",
            name: "formal_paper_trade_ai_review",
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["decision", "confidence", "reason"],
              properties: {
                decision: { type: "string", enum: ["pass", "watch", "reject"] },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                reason: { type: "string" }
              }
            },
            strict: true
          }
        },
        reasoning: { effort: "low" }
      })
    });

    if (!response.ok) throw new Error(`OpenAI API ${response.status}`);
    const payload = await response.json();
    const parsed = safeJsonParse(payload.output_text || extractOutputText(payload));
    if (!parsed?.decision) throw new Error("AI JSON shape invalid");
    return {
      source: config.openaiModel,
      decision: parsed.decision,
      confidence: clamp(Number(parsed.confidence || 0), 0, 1),
      reason: String(parsed.reason || "").slice(0, 240)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function buildFormalCandidates() {
  const spotRaw = await client.getSpotSymbols();
  const spotUniverse = filterTradableSymbols(spotRaw, config.scan).map((market) => withMarketSource(market, "spot"));
  const selected = spotUniverse.slice(0, options.symbolLimit);
  const regime = buildMarketRegime({ spotMarkets: spotUniverse, preferredMarketType: "spot" });
  const timeframePlan = buildTimeframePlan();

  const candidates = await mapWithConcurrency(selected, options.requestConcurrency, async (market) => {
    try {
      const [microstructure, candlesByInterval] = await Promise.all([
        client.getMarketMicrostructure("spot", market.symbol, {
          depthLimit: config.direction.depthLimit,
          aggTradeLimit: config.direction.aggTradeLimit
        }),
        fetchCandlesByInterval(market.symbol, timeframePlan.fetchIntervals)
      ]);
      const enriched = enrichMarketWithDirection({ market, microstructure, regime });
      const snapshotsByInterval = buildSnapshotsByInterval(enriched, candlesByInterval);
      const executionSnapshot = snapshotsByInterval[timeframePlan.executionInterval];
      const sourceSnapshot = snapshotsByInterval[timeframePlan.sourceSignalInterval] || executionSnapshot;
      if (!executionSnapshot) return [];
      return buildFormalCandidatesForSnapshot(
        executionSnapshot,
        microstructure,
        Object.values(snapshotsByInterval),
        sourceSnapshot
      );
    } catch (error) {
      return [];
    }
  });

  const baseCandidates = candidates.flat().filter(Boolean);
  const evaluatedCandidates = baseCandidates.map((candidate) => evaluateCandidateWithProfile(candidate, resolveRiskProfile()));
  const formalCandidates = evaluatedCandidates
    .filter((candidate) => candidate.accepted)
    .sort((a, b) => b.score - a.score);
  const tradeCandidates = evaluatedCandidates
    .filter(isTradeCandidate)
    .sort(compareTradeCandidates);
  const scalpAlerts = buildScalpAlerts(evaluatedCandidates);
  const scalpCandidates = buildScalpCandidates(evaluatedCandidates);
  const watchlistCandidates = buildWatchlistCandidates(evaluatedCandidates);
  const watchCandidates = buildWatchCandidates(evaluatedCandidates);
  const shadowProfiles = Object.fromEntries(
    options.shadowProfiles.map((profile) => {
      const resolved = resolveRiskProfile(profile);
      return [
        resolved.name,
        baseCandidates.map((candidate) => evaluateCandidateWithProfile(candidate, resolved))
      ];
    })
  );

  return {
    regime,
    eligibleSpotMarkets: spotUniverse.length,
    analyzedMarkets: selected.length,
    timeframePlan,
    rawCandidateCount: evaluatedCandidates.length,
    filterDiagnostics: summarizeCandidateFilters(evaluatedCandidates),
    tierDiagnostics: summarizeCandidateTiers(evaluatedCandidates),
    watchDiagnostics: summarizeCandidateFilters(watchCandidates),
    evaluatedCandidates,
    shadowProfiles,
    scalpAlerts,
    scalpCandidates,
    watchlistCandidates,
    watchCandidates,
    formalCandidates,
    tradeCandidates,
    nearPassCandidates: evaluatedCandidates
      .filter((candidate) => !candidate.accepted)
      .sort(compareNearPassCandidates)
      .slice(0, 20),
    rejectedCandidates: evaluatedCandidates
      .filter((candidate) => !candidate.accepted)
      .sort((a, b) => b.score - a.score),
    candidates: tradeCandidates
  };
}

function buildTimeframePlan() {
  const executionInterval = options.signalInterval;
  const sourceSignalInterval = options.sourceSignalInterval || executionInterval;
  const confirmationIntervals = uniqueValues(options.confirmationIntervals || []);
  const fetchIntervals = uniqueValues([executionInterval, sourceSignalInterval, ...confirmationIntervals]);
  return {
    executionInterval,
    sourceSignalInterval,
    confirmationIntervals,
    fetchIntervals
  };
}

async function fetchCandlesByInterval(symbol, intervals) {
  const entries = await Promise.all(
    intervals.map(async (interval) => [
      interval,
      await client.getKlines("spot", symbol, interval, options.klineLimit)
    ])
  );
  return Object.fromEntries(entries);
}

function buildSnapshotsByInterval(market, candlesByInterval = {}) {
  return Object.fromEntries(
    Object.entries(candlesByInterval).map(([interval, candles]) => {
      const snapshot = buildMarketSnapshot({ market, interval, candles });
      return [
        interval,
        {
          ...snapshot,
          liveCandle: buildLiveCandleState(candles)
        }
      ];
    })
  );
}

function buildLiveCandleState(candles = [], nowMs = Date.now()) {
  const raw = Array.isArray(candles) ? candles.filter(Boolean) : [];
  const latest = raw[raw.length - 1];
  if (!latest) return null;

  const closed = raw.filter((item) => Number(item.closeTime) <= nowMs);
  const latestIsLive = Number(latest.closeTime) > nowMs;
  const previous = latestIsLive ? closed[closed.length - 1] : closed[closed.length - 2];
  const volumeBase = mean(closed.slice(-21, -1).map((item) => Number(item.volume)).filter(Number.isFinite));
  const elapsedRatio = Number(latest.closeTime) > Number(latest.openTime)
    ? clamp((nowMs - Number(latest.openTime)) / (Number(latest.closeTime) - Number(latest.openTime)), 0.05, 1)
    : 1;
  const fromOpenPercent = latest.open ? ((Number(latest.close) - Number(latest.open)) / Number(latest.open)) * 100 : 0;
  const fromPreviousClosePercent = previous?.close
    ? ((Number(latest.close) - Number(previous.close)) / Number(previous.close)) * 100
    : fromOpenPercent;
  const rawVolumeRatio = volumeBase ? Number(latest.volume) / volumeBase : null;
  const projectedVolumeRatio = rawVolumeRatio && latestIsLive ? rawVolumeRatio / elapsedRatio : rawVolumeRatio;

  return {
    isLive: latestIsLive,
    openTime: Number.isFinite(Number(latest.openTime)) ? new Date(Number(latest.openTime)).toISOString() : null,
    closeTime: Number.isFinite(Number(latest.closeTime)) ? new Date(Number(latest.closeTime)).toISOString() : null,
    elapsedRatio: round(elapsedRatio, 4),
    fromOpenPercent: round(fromOpenPercent, 4),
    fromPreviousClosePercent: round(fromPreviousClosePercent, 4),
    rawVolumeRatio: Number.isFinite(rawVolumeRatio) ? round(rawVolumeRatio, 4) : null,
    projectedVolumeRatio: Number.isFinite(projectedVolumeRatio) ? round(projectedVolumeRatio, 4) : null,
    highDistancePercent: latest.close ? round(((Number(latest.high) - Number(latest.close)) / Number(latest.close)) * 100, 4) : null,
    lowDistancePercent: latest.close ? round(((Number(latest.close) - Number(latest.low)) / Number(latest.close)) * 100, 4) : null
  };
}

function buildTimeframeAlignment(side, snapshot, timeframeSnapshots = []) {
  const baseWeight = monitorTimeframeWeight[snapshot.interval] || 0;
  const related = timeframeSnapshots
    .filter((item) => item.symbol === snapshot.symbol)
    .filter((item) => item.marketType === snapshot.marketType)
    .filter((item) => (monitorTimeframeWeight[item.interval] || 0) > baseWeight);
  const supporting = [];
  const opposing = [];
  const neutral = [];

  for (const item of related) {
    const compact = compactTimeframeSnapshot(item);
    if (trendSupportsSide(item.trend, side)) supporting.push(compact);
    else if (trendOpposesSide(item.trend, side)) opposing.push(compact);
    else neutral.push(compact);
  }

  const hardOpposing = opposing.filter((item) => item.interval === "1h" || item.interval === "4h" || item.interval === "1d");
  const hasHigherSupport = supporting.some((item) => item.interval === "1h" || item.interval === "4h" || item.interval === "1d");
  const hasSourceSupport = supporting.some((item) => item.interval === options.sourceSignalInterval);

  return {
    currentInterval: snapshot.interval,
    checkedIntervals: related.map((item) => item.interval),
    supporting,
    opposing,
    neutral,
    hardOpposing,
    hasHigherSupport,
    hasSourceSupport,
    confirmed: hardOpposing.length === 0 && (hasHigherSupport || hasSourceSupport)
  };
}

function compactTimeframeSnapshot(snapshot) {
  return {
    interval: snapshot.interval,
    trend: snapshot.trend,
    rsi: snapshot.indicators?.rsi,
    macdHistogram: snapshot.indicators?.macdHistogram,
    volumeRatio: snapshot.indicators?.volumeRatio
  };
}

function trendSupportsSide(trend, side) {
  if (side === "long") return trend === "up" || trend === "recovering";
  if (side === "short") return trend === "down" || trend === "weakening";
  return false;
}

function trendOpposesSide(trend, side) {
  if (side === "long") return trend === "down" || trend === "weakening";
  if (side === "short") return trend === "up" || trend === "recovering";
  return false;
}

function buildMomentumProfile({ side, snapshot, edgeAligned, score, timeframeAlignment, sourceSignal }) {
  const live = snapshot.liveCandle || {};
  const directionSign = side === "long" ? 1 : -1;
  const liveMovePercent = directionSign * Number(live.fromPreviousClosePercent ?? live.fromOpenPercent ?? 0);
  const closedMovePercent = directionSign * Number(snapshot.candleChangePercent || 0);
  const volumeRatio = Math.max(
    Number(snapshot.indicators?.volumeRatio || 0),
    Number(live.projectedVolumeRatio || 0),
    Number(live.rawVolumeRatio || 0)
  );
  const priceChange24h = Number(snapshot.priceChangePercent24h || 0);
  const chaseOk = side === "long"
    ? priceChange24h <= options.momentumMaxLongChase24hPercent
    : priceChange24h >= -options.momentumMaxShortChase24hPercent;
  const fakeoutRisk = side === "long"
    ? snapshot.indicatorState?.breakoutBias === "bullish_fakeout_risk"
    : snapshot.indicatorState?.breakoutBias === "bearish_fakeout_risk";
  const hardOpposing = timeframeAlignment?.hardOpposing || [];
  const sourceScore = Number(sourceSignal?.score);
  const sourceSupport = Boolean(timeframeAlignment?.hasSourceSupport);
  const higherSupport = Boolean(timeframeAlignment?.hasHigherSupport);
  const moveOk = liveMovePercent >= options.momentumMinLiveMovePercent
    || closedMovePercent >= options.momentumMinClosedMovePercent;

  const checks = {
    enabled: options.momentumEntryEnabled,
    score: Number(score) >= options.momentumMinScore,
    edge: Number(edgeAligned) >= options.momentumMinEdge,
    volume: volumeRatio >= options.momentumMinVolumeRatio,
    move: moveOk,
    timeframe: hardOpposing.length === 0 && (sourceSupport || higherSupport),
    chase: chaseOk,
    fakeout: !fakeoutRisk
  };
  const qualified = Object.values(checks).every(Boolean);

  return {
    qualified,
    checks,
    liveMovePercent: round(liveMovePercent, 4),
    closedMovePercent: round(closedMovePercent, 4),
    volumeRatio: round(volumeRatio, 4),
    sourceScore: Number.isFinite(sourceScore) ? sourceScore : null,
    sourceSupport,
    higherSupport,
    hardOpposing: hardOpposing.map((item) => `${item.interval}:${item.trend}`),
    reason: qualified
      ? "short-term momentum breakout candidate"
      : Object.entries(checks)
        .filter(([, passed]) => !passed)
        .map(([key]) => key)
        .join(", ")
  };
}

function buildScalpAlertProfile(candidate) {
  const live = candidate.liveCandle || {};
  const move = directionalMove(candidate);
  const volumeRatio = directionalVolumeRatio(candidate);
  const nearExtreme = candidate.side === "long"
    ? Number(live.highDistancePercent ?? 999) <= 0.12
    : Number(live.lowDistancePercent ?? 999) <= 0.12;
  const moveTriggered = move.liveMovePercent >= options.scalpAlertMinMovePercent
    || move.closedMovePercent >= options.scalpAlertMinMovePercent;
  const volumeTriggered = volumeRatio >= options.scalpAlertMinVolumeRatio;
  const edgeTriggered = Number(candidate.edgeAligned || 0) >= options.scalpAlertMinEdge;
  const sourceTriggered = Number(candidate.sourceSignal?.score || 0) >= 80;
  const triggered = moveTriggered && (volumeTriggered || edgeTriggered || nearExtreme || sourceTriggered);
  const score = [
    Math.min(35, Math.max(0, move.liveMovePercent) * 70),
    Math.min(25, Math.max(0, move.closedMovePercent) * 60),
    Math.min(20, Math.max(0, volumeRatio - 1) * 12),
    Math.min(20, Math.max(0, Number(candidate.edgeAligned || 0)) / 2),
    nearExtreme ? 8 : 0,
    sourceTriggered ? 8 : 0
  ].reduce((sum, value) => sum + value, 0);

  const reasons = [];
  if (moveTriggered) reasons.push("fast_directional_move");
  if (volumeTriggered) reasons.push("volume_expansion");
  if (edgeTriggered) reasons.push("microstructure_edge");
  if (nearExtreme) reasons.push(candidate.side === "long" ? "near_intrabar_high" : "near_intrabar_low");
  if (sourceTriggered) reasons.push("source_signal_heat");

  return {
    triggered,
    score: round(score, 2),
    liveMovePercent: round(move.liveMovePercent, 4),
    closedMovePercent: round(move.closedMovePercent, 4),
    volumeRatio: round(volumeRatio, 4),
    nearExtreme,
    reasons,
    riskFlags: scalpAlertRiskFlags(candidate)
  };
}

function buildScalpDecisionProfile(candidate) {
  const alert = candidate.scalpAlertProfile || buildScalpAlertProfile(candidate);
  const momentum = candidate.momentumProfile || {};
  const sideConsensus = candidate.technicalConsensus?.[candidate.side] || {};
  const sourceOk = hasActionableSourceSignal(candidate) || Number(candidate.sourceSignal?.score || 0) >= 82;
  const noSourceMicrostructure = hasNoSourceMicrostructureScalp(candidate, alert);
  const noSourceExhaustion = noSourceScalpExhaustion(candidate, alert);
  const technicalOk = Boolean(candidate.technicalAligned || sideConsensus.allowed);
  const timeframeOk = !candidate.timeframeAlignment?.hardOpposing?.length
    && Boolean(candidate.timeframeAlignment?.hasSourceSupport || candidate.timeframeAlignment?.hasHigherSupport);
  const chaseOk = candidate.side === "long"
    ? Number(candidate.priceChangePercent24h || 0) <= options.momentumMaxLongChase24hPercent
    : Number(candidate.priceChangePercent24h || 0) >= -options.momentumMaxShortChase24hPercent;
  const checks = {
    alert: alert.triggered,
    score: Number(candidate.score || 0) >= options.scalpDecisionMinScore,
    edge: Number(candidate.edgeAligned || 0) >= options.scalpDecisionMinEdge,
    volume: Number(alert.volumeRatio || 0) >= options.scalpDecisionMinVolumeRatio || noSourceMicrostructure,
    move: Number(alert.liveMovePercent || 0) >= options.scalpAlertMinMovePercent
      || Number(alert.closedMovePercent || 0) >= options.scalpAlertMinMovePercent,
    timeframe: timeframeOk,
    technical: technicalOk,
    sourceOrMomentum: sourceOk || Boolean(momentum.qualified) || sideConsensus.strong || noSourceMicrostructure,
    freshness: !noSourceExhaustion.exhausted,
    chase: chaseOk,
    spread: Number(candidate.spreadPercent || 0) <= options.maxFormalSpreadPercent,
    netTarget: Number(candidate.netTargetPercent || 0) >= options.scalpMinNetTargetPercent,
    rewardRisk: Number(candidate.rewardRisk || 0) >= options.scalpMinRewardRisk,
    volatility: Number(candidate.atrPercent || 0) <= options.maxAtrPercent
  };
  const qualified = Object.values(checks).every(Boolean);

  return {
    qualified,
    checks,
    alertScore: alert.score,
    noSourceMicrostructure,
    noSourceExhaustion,
    reason: qualified
      ? "scalp alert passed quick decision checks"
      : Object.entries(checks)
        .filter(([, passed]) => !passed)
        .map(([key]) => key)
        .join(", ")
  };
}

function hasNoSourceMicrostructureScalp(candidate, alert = candidate?.scalpAlertProfile || {}) {
  if (!options.scalpAllowNoSourceMicrostructure) return false;
  if (candidate.sourceSignal) return false;
  if (!alert.triggered) return false;
  if (candidate.timeframeAlignment?.hardOpposing?.length) return false;
  if ((alert.riskFlags || []).length) return false;
  if (Number(candidate.spreadPercent || 0) > options.maxFormalSpreadPercent) return false;
  if (Number(candidate.atrPercent || 0) > options.maxAtrPercent) return false;
  if (noSourceScalpExhaustion(candidate, alert).exhausted) return false;

  const edge = Number(candidate.edgeAligned || 0);
  const volume = Number(alert.volumeRatio || 0);
  const liveMove = Number(alert.liveMovePercent || 0);
  const closedMove = Number(alert.closedMovePercent || 0);
  const impulseOk = closedMove >= options.scalpNoSourceMinClosedMovePercent;
  const highEdgeOk = edge >= options.scalpNoSourceHighEdge
    && volume >= options.scalpNoSourceHighEdgeMinVolumeRatio;
  const mediumEdgeOk = edge >= options.scalpNoSourceMediumEdge
    && volume >= options.scalpNoSourceMediumEdgeMinVolumeRatio;

  return impulseOk && (highEdgeOk || mediumEdgeOk);
}

function noSourceScalpExhaustion(candidate, alert = candidate?.scalpAlertProfile || {}) {
  if (candidate?.sourceSignal) {
    return {
      exhausted: false,
      reasons: [],
      liveMovePercent: Number(alert.liveMovePercent || 0),
      closedMovePercent: Number(alert.closedMovePercent || 0),
      maxLiveMovePercent: options.scalpNoSourceMaxLiveMovePercent,
      maxClosedMovePercent: options.scalpNoSourceMaxClosedMovePercent
    };
  }

  const move = alert.liveMovePercent == null || alert.closedMovePercent == null
    ? directionalMove(candidate)
    : alert;
  const liveMove = Number(move.liveMovePercent || 0);
  const closedMove = Number(move.closedMovePercent || 0);
  const reasons = [];
  if (liveMove > options.scalpNoSourceMaxLiveMovePercent) reasons.push("live_move_overextended");
  if (closedMove > options.scalpNoSourceMaxClosedMovePercent) reasons.push("closed_move_overextended");

  return {
    exhausted: reasons.length > 0,
    reasons,
    liveMovePercent: round(liveMove, 4),
    closedMovePercent: round(closedMove, 4),
    maxLiveMovePercent: options.scalpNoSourceMaxLiveMovePercent,
    maxClosedMovePercent: options.scalpNoSourceMaxClosedMovePercent
  };
}

function directionalMove(candidate) {
  const live = candidate.liveCandle || {};
  const directionSign = candidate.side === "long" ? 1 : -1;
  return {
    liveMovePercent: directionSign * Number(live.fromPreviousClosePercent ?? live.fromOpenPercent ?? 0),
    closedMovePercent: directionSign * Number(candidate.candleChangePercent || 0)
  };
}

function directionalVolumeRatio(candidate) {
  const live = candidate.liveCandle || {};
  return Math.max(
    Number(candidate.volumeRatio || 0),
    Number(live.projectedVolumeRatio || 0),
    Number(live.rawVolumeRatio || 0)
  );
}

function scalpAlertRiskFlags(candidate) {
  const flags = [];
  if (candidate.timeframeAlignment?.hardOpposing?.length) flags.push("higher_timeframe_conflict");
  if (Number(candidate.spreadPercent || 0) > options.maxFormalSpreadPercent) flags.push("wide_spread");
  if (Number(candidate.atrPercent || 0) > options.maxAtrPercent) flags.push("high_volatility");
  if (candidate.side === "long" && Number(candidate.priceChangePercent24h || 0) > options.momentumMaxLongChase24hPercent) flags.push("long_chase24h");
  if (candidate.side === "short" && Number(candidate.priceChangePercent24h || 0) < -options.momentumMaxShortChase24hPercent) flags.push("short_chase24h");
  return flags;
}

function buildActionPlan(side, tradeStyle = "formal") {
  const isLong = side === "long";
  return {
    open: isLong ? "买入开多" : "卖出开空",
    takeProfit: isLong ? "卖出止盈" : "买回止盈",
    stopLoss: isLong ? "卖出止损" : "买回止损",
    close: isLong ? "卖出平多" : "买回平空",
    directionText: isLong ? "看多" : "看空",
    styleText: tradeStyle === "scalp_momentum" ? "超短线动量" : "正式趋势",
    maxHoldMinutes: tradeStyle === "scalp_momentum" ? options.scalpMaxHoldMinutes : null
  };
}

function applyTradeStylePlan(candidate, tradeStyle = "formal") {
  if (tradeStyle !== "scalp_momentum") {
    return {
      ...candidate,
      tradeStyle,
      actionPlan: buildActionPlan(candidate.side, tradeStyle)
    };
  }

  const entryPrice = Number(candidate.entryPrice || 0);
  const targetPercent = clamp(Number(options.scalpTargetPercent || 0), 0.01, options.maxTargetPercent);
  const stopPercent = clamp(Number(options.scalpStopPercent || 0), 0.01, options.maxStopPercent);
  const roundTripCostPercent = estimateFormalRoundTripCost().totalCostPercent;
  const netTargetPercent = targetPercent - roundTripCostPercent;
  const rewardRisk = stopPercent > 0 ? targetPercent / stopPercent : null;

  return {
    ...candidate,
    tradeStyle,
    actionPlan: buildActionPlan(candidate.side, tradeStyle),
    takeProfit: round(applyMove(entryPrice, candidate.side, targetPercent), 10),
    stopLoss: round(applyMove(entryPrice, candidate.side, -stopPercent), 10),
    targetPercent: round(targetPercent, 4),
    stopPercent: round(stopPercent, 4),
    roundTripCostPercent: round(roundTripCostPercent, 4),
    netTargetPercent: round(netTargetPercent, 4),
    rewardRisk: Number.isFinite(rewardRisk) ? round(rewardRisk, 4) : null
  };
}

function buildWatchCandidates(candidates = []) {
  if (!options.watchEnabled) return [];
  return candidates
    .filter(isWatchCandidate)
    .filter((candidate) => !isTradeCandidate(candidate))
    .map((candidate) => ({
      ...candidate,
      signalTier: "watch",
      watchOnly: true,
      watchReason: explainWatchCandidate(candidate)
    }))
    .sort(compareNearPassCandidates)
    .slice(0, Math.max(0, options.watchMaxCandidates));
}

function buildScalpAlerts(candidates = []) {
  return candidates
    .filter((candidate) => candidate.scalpAlertProfile?.triggered)
    .sort(compareScalpAlerts)
    .slice(0, Math.max(0, options.scalpAlertMaxCandidates));
}

function buildScalpCandidates(candidates = []) {
  return candidates
    .filter((candidate) => hasScalpEntry(candidate))
    .filter(isTradeCandidate)
    .sort(compareTradeCandidates)
    .slice(0, Math.max(0, options.scalpAlertMaxCandidates));
}

function buildWatchlistCandidates(candidates = []) {
  return candidates
    .filter(isWatchlistCandidate)
    .sort(compareWatchlistCandidates)
    .slice(0, Math.max(0, options.watchlistMaxCandidates));
}

function hasScalpEntry(candidate) {
  return Boolean(candidate?.momentumProfile?.qualified || candidate?.scalpDecisionProfile?.qualified);
}

function classifyOpportunityLayer(candidate) {
  if (hasScalpEntry(candidate)) return "scalp_decision";
  if (candidate?.scalpAlertProfile?.triggered) return "scalp_alert";
  if (candidate?.accepted || candidate?.timeframeAlignment?.confirmed || candidate?.sourceSignal) return "watchlist";
  return "blocked";
}

function isTradeCandidate(candidate) {
  if (!candidate) return false;
  return tradeCandidateBlockers(candidate).length === 0;
}

function isWatchlistCandidate(candidate) {
  if (!candidate || hasScalpEntry(candidate)) return false;
  if (candidate.hardFailures?.length) return false;
  if (candidate.filterFailures?.some((failure) => hardSafetyFailures.has(failure))) return false;
  if (candidate.score < options.watchlistMinScore) return false;
  if (candidate.edgeAligned < options.watchlistMinEdge && !candidate.sourceSignal) return false;
  return Boolean(
    candidate.accepted
      || candidate.timeframeAlignment?.confirmed
      || candidate.timeframeAlignment?.hasHigherSupport
      || candidate.sourceSignal
  );
}

function isWatchCandidate(candidate) {
  if (!candidate || candidate.accepted) return false;
  const failures = candidate.filterFailures || [];
  if (!failures.length || failures.length > options.watchMaxFailures) return false;
  if (candidate.hardFailures?.length || failures.some((failure) => hardSafetyFailures.has(failure))) return false;
  if (candidate.score < options.watchMinScore) return false;
  if (candidate.edgeAligned < options.watchMinEdge && !candidate.sourceSignal) return false;
  return true;
}

function explainWatchCandidate(candidate) {
  const failures = new Set(candidate.filterFailures || []);
  const reasons = [];
  if (failures.has("edge")) reasons.push(`direction edge ${candidate.edgeAligned} below formal ${options.minEdge}`);
  if (failures.has("score")) reasons.push(`score ${candidate.score} below formal ${options.minScore}`);
  if (failures.has("technical")) reasons.push("technical consensus is not fully aligned");
  if (failures.has("volume")) reasons.push(`volume ratio ${candidate.volumeRatio} below formal ${options.minVolumeRatio}`);
  if (failures.has("source_quality")) reasons.push("source signal failed quality review");
  if (failures.has("entry_quality")) reasons.push("missing actionable source signal or strong side technical consensus");
  if (failures.has("timeframe_confirmation")) reasons.push("higher timeframe confirmation is incomplete");
  return reasons.join("; ") || "near formal setup, keep watching";
}

function compareTradeCandidates(a, b) {
  const tierDiff = candidateTierPriority(b) - candidateTierPriority(a);
  if (tierDiff) return tierDiff;
  const softDiff = (a.softFailures?.length || 0) - (b.softFailures?.length || 0);
  if (softDiff) return softDiff;
  const scoreDiff = b.score - a.score;
  if (scoreDiff) return scoreDiff;
  return b.edgeAligned - a.edgeAligned;
}

function compareScalpAlerts(a, b) {
  const scoreDiff = Number(b.scalpAlertProfile?.score || 0) - Number(a.scalpAlertProfile?.score || 0);
  if (scoreDiff) return scoreDiff;
  const riskDiff = (a.scalpAlertProfile?.riskFlags?.length || 0) - (b.scalpAlertProfile?.riskFlags?.length || 0);
  if (riskDiff) return riskDiff;
  return b.edgeAligned - a.edgeAligned;
}

function compareWatchlistCandidates(a, b) {
  const acceptedDiff = Number(b.accepted) - Number(a.accepted);
  if (acceptedDiff) return acceptedDiff;
  const higherDiff = Number(Boolean(b.timeframeAlignment?.hasHigherSupport)) - Number(Boolean(a.timeframeAlignment?.hasHigherSupport));
  if (higherDiff) return higherDiff;
  const scoreDiff = b.score - a.score;
  if (scoreDiff) return scoreDiff;
  return b.edgeAligned - a.edgeAligned;
}

function candidateTierPriority(candidate) {
  if (candidate.signalTier === "formal") return 4;
  if (candidate.signalTier === "trade_candidate") return 3;
  if (candidate.signalTier === "watch") return 2;
  return 0;
}

function buildFormalCandidatesForSnapshot(snapshot, microstructure, timeframeSnapshots = [snapshot], sourceSnapshot = snapshot) {
  const usableSnapshots = Array.isArray(timeframeSnapshots) && timeframeSnapshots.length ? timeframeSnapshots : [snapshot];
  const directSignalSnapshot = sourceSnapshot || snapshot;
  const rawSourceSignals = generateSignalsFromSnapshot(directSignalSnapshot);
  const reviewedSourceSignals = reviewSignalsForQuality(rawSourceSignals, usableSnapshots, 8);
  return ["long", "short"].map((side) => {
    const sourceSignal = selectSourceSignalForSide(reviewedSourceSignals, side);
    return buildBaseFormalCandidate(snapshot, microstructure, side, sourceSignal, usableSnapshots);
  });
}

function buildBaseFormalCandidate(snapshot, microstructure, side, sourceSignal = null, timeframeSnapshots = [snapshot]) {
  const edge = Number(snapshot.directionAnalysis?.edgeScore || 0);
  const volume = Number(snapshot.indicators.volumeRatio || 0);
  const selected = scoreCandidateSide(snapshot, edge, side, sourceSignal);
  const edgeAligned = side === "long" ? edge : -edge;
  const timeframeAlignment = buildTimeframeAlignment(side, snapshot, timeframeSnapshots);
  const momentumProfile = buildMomentumProfile({
    side,
    snapshot,
    edgeAligned,
    score: selected.score,
    timeframeAlignment,
    sourceSignal
  });

  const orderBook = microstructure?.orderBook || {};
  const entryPrice = executablePrice(orderBook, side, "open") || snapshot.price;
  const atrPercent = snapshot.indicators.atr && entryPrice
    ? (snapshot.indicators.atr / entryPrice) * 100
    : options.minStopPercent;
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
  const roundTripCostPercent = estimateFormalRoundTripCost().totalCostPercent;
  const netTargetPercent = targetPercent - roundTripCostPercent;
  const rewardRisk = stopPercent > 0 ? targetPercent / stopPercent : null;

  const candidate = {
    accepted: false,
    symbol: snapshot.symbol,
    side,
    score: selected.score,
    directionEdge: edge,
    direction: snapshot.directionAnalysis?.direction,
    edgeAligned,
    filterFailures: [],
    technicalAligned: selected.technicalAligned,
    entryPrice: round(entryPrice, 10),
    takeProfit: round(applyMove(entryPrice, side, targetPercent), 10),
    stopLoss: round(applyMove(entryPrice, side, -stopPercent), 10),
    targetPercent: round(targetPercent, 4),
    stopPercent: round(stopPercent, 4),
    roundTripCostPercent: round(roundTripCostPercent, 4),
    netTargetPercent: round(netTargetPercent, 4),
    rewardRisk: Number.isFinite(rewardRisk) ? round(rewardRisk, 4) : null,
    volumeRatio: round(volume, 4),
    atrPercent: round(atrPercent, 4),
    spreadPercent: round(snapshot.spreadPercent, 4),
    quoteVolume: round(snapshot.quoteVolume, 2),
    trend: snapshot.trend,
    timeframeAlignment,
    momentumProfile,
    rsi: snapshot.indicators.rsi,
    macdHistogram: snapshot.indicators.macdHistogram,
    candleChangePercent: snapshot.candleChangePercent,
    liveCandle: snapshot.liveCandle,
    evidence: snapshot.directionAnalysis?.evidence || [],
    technicalConsensus: snapshot.technicalConsensus,
    indicatorState: snapshot.indicatorState,
    candleWindow: snapshot.candleWindow,
    timeframePlan: {
      executionInterval: snapshot.interval,
      sourceSignalInterval: sourceSignal?.timeframe || options.sourceSignalInterval || null,
      confirmationIntervals: timeframeSnapshots
        .map((item) => item.interval)
        .filter((interval) => interval !== snapshot.interval)
        .filter((interval) => interval !== (sourceSignal?.timeframe || options.sourceSignalInterval)),
      availableIntervals: timeframeSnapshots.map((item) => item.interval)
    },
    priceChangePercent24h: snapshot.priceChangePercent24h,
    sourceSignal: compactSourceSignal(sourceSignal),
    reasons: selected.reasons
  };
  const withScalpProfiles = {
    ...candidate,
    scalpAlertProfile: buildScalpAlertProfile(candidate)
  };
  const scalpPlannedCandidate = applyTradeStylePlan(withScalpProfiles, "scalp_momentum");
  const fullCandidate = {
    ...scalpPlannedCandidate,
    scalpDecisionProfile: buildScalpDecisionProfile(scalpPlannedCandidate)
  };
  const tradeStyle = hasScalpEntry(fullCandidate) ? "scalp_momentum" : "formal";
  const candidateWithDecision = {
    ...(tradeStyle === "scalp_momentum" ? fullCandidate : withScalpProfiles),
    scalpDecisionProfile: fullCandidate.scalpDecisionProfile,
    opportunityLayer: classifyOpportunityLayer(fullCandidate)
  };
  const plannedCandidate = applyTradeStylePlan(candidateWithDecision, tradeStyle);

  return {
    ...plannedCandidate,
    tradeStyle,
    actionPlan: buildActionPlan(side, tradeStyle),
    strategyGroup: `${tradeStyle}:${side}:${options.signalInterval}`,
    opportunityLayer: classifyOpportunityLayer(fullCandidate)
  };
}

function selectSourceSignalForSide(signals = [], side) {
  const directions = side === "long" ? new Set(["spot_buy", "long"]) : new Set(["spot_sell", "short"]);
  return signals
    .filter((signal) => directions.has(signal.direction))
    .sort((a, b) => {
      const actionable = Number(b.quality?.status === "actionable") - Number(a.quality?.status === "actionable");
      if (actionable) return actionable;
      const scoreDiff = Number(b.score || 0) - Number(a.score || 0);
      if (scoreDiff) return scoreDiff;
      return Number(b.riskReward || 0) - Number(a.riskReward || 0);
    })[0] || null;
}

function compactSourceSignal(signal = null) {
  if (!signal) return null;
  return {
    direction: signal.direction,
    timeframe: signal.timeframe,
    score: signal.score,
    ruleScore: signal.ruleScore ?? null,
    riskReward: signal.riskReward ?? null,
    qualityStatus: signal.quality?.status || null,
    qualityProblems: (signal.quality?.problems || []).slice(0, 4),
    qualityNotes: (signal.quality?.notes || []).slice(0, 4),
    entryRange: signal.entryRange || null,
    stopLoss: signal.stopLoss ?? null,
    takeProfit: signal.takeProfit || null
  };
}

function hasActionableSourceSignal(candidate) {
  return candidate?.sourceSignal?.qualityStatus === "actionable";
}

function hasFilteredSourceSignal(candidate) {
  return candidate?.sourceSignal?.qualityStatus === "filtered";
}

function hasMomentumEntry(candidate) {
  return hasScalpEntry(candidate);
}

function sideTechnicalConsensus(candidate) {
  if (!candidate?.technicalConsensus || !candidate.side) return null;
  return candidate.technicalConsensus[candidate.side] || null;
}

function hasStrongSideTechnicalConsensus(candidate) {
  return Boolean(sideTechnicalConsensus(candidate)?.strong);
}

function hasFormalEntryQuality(candidate) {
  if (!options.formalRequireEntryQuality) return true;
  if (hasMomentumEntry(candidate)) return true;
  if (hasActionableSourceSignal(candidate)) return true;
  // v2 优化：即使 sourceSignal 未通过质量审查，只要自身技术确认足够强也可以通过
  // 原有逻辑：必须 actionable sourceSignal → 导致 100% 拦截（27/27 sourceSignal 都是 filtered）
  if (hasStrongSideTechnicalConsensus(candidate)) return true;
  // v2 新增：sourceSignal 虽然 filtered 但评分 ≥ 62（原70，Phase 1下调）+ 边缘分达标 → 可放宽
  const sourceOk = candidate?.sourceSignal?.score >= options.filteredSourceMinScore
    && candidate?.sourceSignal?.qualityStatus === "filtered"
    && (candidate?.edgeAligned || 0) >= options.executionMinEdge
    && candidate?.technicalAligned;
  if (sourceOk) return true;
  return false;
}

function evaluateCandidateWithProfile(candidate, profile = resolveRiskProfile()) {
  const resolved = resolveRiskProfile(profile);
  const safetyProfile = hasMomentumEntry(candidate)
    ? {
        ...resolved,
        minNetTargetPercent: options.scalpMinNetTargetPercent,
        minRewardRisk: options.scalpMinRewardRisk
      }
    : resolved;
  const filterFailures = [];
  if (candidate.edgeAligned <= -options.edgeContradiction) filterFailures.push("edge_contradiction");
  else if (candidate.edgeAligned < resolved.minEdge) filterFailures.push("edge");
  if (candidate.score < resolved.minScore) filterFailures.push("score");
  if (!candidate.technicalAligned) filterFailures.push("technical");
  if (candidate.volumeRatio < resolved.minVolumeRatio) filterFailures.push("volume");
  if (hasFilteredSourceSignal(candidate)) filterFailures.push("source_quality");
  if (!hasFormalEntryQuality(candidate)) filterFailures.push("entry_quality");
  if (candidate.timeframeAlignment?.hardOpposing?.length) filterFailures.push("timeframe_conflict");
  else if (candidate.timeframeAlignment && !candidate.timeframeAlignment.confirmed) {
    filterFailures.push("timeframe_confirmation");
  }

  filterFailures.push(...buildFormalSafetyFailures(candidate, {
    maxChase24hPercent: safetyProfile.maxChase24hPercent,
    maxLongChase24hPercent: safetyProfile.maxLongChase24hPercent,
    maxShortChase24hPercent: safetyProfile.maxShortChase24hPercent,
    maxAtrPercent: safetyProfile.maxAtrPercent,
    maxSpreadPercent: safetyProfile.maxFormalSpreadPercent,
    minNetTargetPercent: safetyProfile.minNetTargetPercent,
    minRewardRisk: safetyProfile.minRewardRisk
  }));

  const margins = candidateMargins(candidate, safetyProfile);
  const hardFailures = filterFailures.filter((failure) => failure === "edge_contradiction" || hardSafetyFailures.has(failure));
  const softFailures = filterFailures.filter((failure) => softSignalFailures.has(failure));
  const accepted = filterFailures.length === 0;
  const tradeBlockers = tradeCandidateBlockers({ ...candidate, accepted, hardFailures, softFailures });
  const signalTier = accepted
    ? "formal"
    : hardFailures.length
      ? "blocked"
      : tradeBlockers.length === 0
        ? "trade_candidate"
        : "watch";
  return {
    ...candidate,
    profileName: resolved.name,
    signalTier,
    accepted,
    filterFailures,
    hardFailures,
    softFailures,
    tradeBlockers,
    opportunityLayer: classifyOpportunityLayer({ ...candidate, accepted }),
    margins,
    nearPassScore: nearPassScore(filterFailures, margins)
  };
}

function tradeCandidateBlockers(candidate) {
  const blockers = [];
  if (!candidate) return ["missing_candidate"];
  if (candidate.hardFailures?.length) blockers.push(...candidate.hardFailures);
  const momentumEntry = hasMomentumEntry(candidate);
  // v2 优化：source_quality 只在 entry_quality 也失败时才成为交易拦截器
  // 如果 hasFormalEntryQuality 通过（含新增的 relaxed 路径），则不拦截
  if (hasFilteredSourceSignal(candidate) && !momentumEntry && !hasFormalEntryQuality(candidate)) {
    blockers.push("source_quality");
  }

  if (candidate.accepted) return uniqueValues(blockers);

  const softFailures = candidate.softFailures || [];
  const maxSoftFailures = momentumEntry
    ? Math.max(options.executionMaxSoftFailures, options.momentumMaxSoftFailures)
    : options.executionMaxSoftFailures;
  if (softFailures.length > maxSoftFailures) blockers.push("too_many_soft_failures");
  if (candidate.score < options.executionMinScore) blockers.push("execution_score");
  if (candidate.edgeAligned < options.executionMinEdge) blockers.push("execution_edge");
  if (softFailures.includes("edge") && !hasActionableSourceSignal(candidate)) {
    blockers.push("weak_edge_without_actionable_source");
  }
  if (softFailures.includes("entry_quality")) blockers.push("entry_quality");
  if (softFailures.includes("timeframe_confirmation") && !hasActionableSourceSignal(candidate) && !momentumEntry) {
    blockers.push("missing_timeframe_confirmation");
  }

  return uniqueValues(blockers);
}

function summarizeCandidateFilters(candidates) {
  const failCounts = {};
  for (const candidate of candidates) {
    for (const failure of candidate.filterFailures || []) {
      failCounts[failure] = (failCounts[failure] || 0) + 1;
    }
  }

  return {
    evaluated: candidates.length,
    accepted: candidates.filter((candidate) => candidate.accepted).length,
    rejected: candidates.filter((candidate) => !candidate.accepted).length,
    failCounts
  };
}

function summarizeCandidateTiers(candidates = []) {
  const summary = {};
  for (const candidate of candidates) {
    const tier = candidate.signalTier || "unknown";
    summary[tier] ||= {
      total: 0,
      bySide: {},
      failCounts: {},
      tradeBlockerCounts: {},
      sourceSignalCount: 0,
      sourceQuality: {},
      momentumQualifiedCount: 0
    };
    summary[tier].total += 1;
    if (candidate.momentumProfile?.qualified) summary[tier].momentumQualifiedCount += 1;
    if (candidate.sourceSignal) {
      summary[tier].sourceSignalCount += 1;
      const quality = candidate.sourceSignal.qualityStatus || "unknown";
      summary[tier].sourceQuality[quality] = (summary[tier].sourceQuality[quality] || 0) + 1;
    }
    const side = candidate.side || "unknown";
    summary[tier].bySide[side] = (summary[tier].bySide[side] || 0) + 1;
    for (const failure of candidate.filterFailures || []) {
      summary[tier].failCounts[failure] = (summary[tier].failCounts[failure] || 0) + 1;
    }
    for (const blocker of candidate.tradeBlockers || []) {
      summary[tier].tradeBlockerCounts[blocker] = (summary[tier].tradeBlockerCounts[blocker] || 0) + 1;
    }
  }
  return summary;
}

function resolveRiskProfile(profile = {}) {
  return {
    name: profile.name || "baseline",
    minEdge: numberWithFallback(profile.minEdge, options.minEdge),
    minScore: numberWithFallback(profile.minScore, options.minScore),
    minVolumeRatio: numberWithFallback(profile.minVolumeRatio, options.minVolumeRatio),
    maxChase24hPercent: numberWithFallback(profile.maxChase24hPercent, options.maxChase24hPercent),
    maxLongChase24hPercent: numberWithFallback(profile.maxLongChase24hPercent, options.maxLongChase24hPercent),
    maxShortChase24hPercent: numberWithFallback(profile.maxShortChase24hPercent, options.maxShortChase24hPercent),
    maxAtrPercent: numberWithFallback(profile.maxAtrPercent, options.maxAtrPercent),
    maxFormalSpreadPercent: numberWithFallback(profile.maxFormalSpreadPercent, options.maxFormalSpreadPercent),
    minNetTargetPercent: numberWithFallback(profile.minNetTargetPercent, options.minNetTargetPercent),
    minRewardRisk: numberWithFallback(profile.minRewardRisk, options.minRewardRisk)
  };
}

function candidateMargins(candidate, profile) {
  const chaseMargin = candidate.side === "long"
    ? profile.maxLongChase24hPercent - Number(candidate.priceChangePercent24h || 0)
    : profile.maxShortChase24hPercent + Number(candidate.priceChangePercent24h || 0);

  return {
    edge: round(candidate.edgeAligned - profile.minEdge, 4),
    score: round(candidate.score - profile.minScore, 4),
    volume: round(candidate.volumeRatio - profile.minVolumeRatio, 4),
    netTarget: round(candidate.netTargetPercent - profile.minNetTargetPercent, 4),
    rewardRisk: Number.isFinite(candidate.rewardRisk) ? round(candidate.rewardRisk - profile.minRewardRisk, 4) : null,
    chase24h: Number.isFinite(chaseMargin) ? round(chaseMargin, 4) : null,
    volatility: round(profile.maxAtrPercent - candidate.atrPercent, 4),
    spread: round(profile.maxFormalSpreadPercent - candidate.spreadPercent, 4)
  };
}

function nearPassScore(filterFailures, margins = {}) {
  const deficit = Object.values(margins)
    .map(Number)
    .filter(Number.isFinite)
    .filter((value) => value < 0)
    .reduce((sum, value) => sum + Math.abs(value), 0);
  return round(filterFailures.length * 100 + deficit, 4);
}

function compareNearPassCandidates(a, b) {
  return a.filterFailures.length - b.filterFailures.length
    || a.nearPassScore - b.nearPassScore
    || b.score - a.score
    || b.edgeAligned - a.edgeAligned;
}

function createAggregateDiagnostics(profileName) {
  return {
    profileName,
    scans: 0,
    evaluated: 0,
    accepted: 0,
    rejected: 0,
    failCounts: {},
    bySide: {},
    nearPassCandidates: []
  };
}

function updateAggregateDiagnostics(target, candidates = []) {
  target.scans += 1;
  target.evaluated += candidates.length;
  target.accepted += candidates.filter((candidate) => candidate.accepted).length;
  target.rejected += candidates.filter((candidate) => !candidate.accepted).length;

  for (const candidate of candidates) {
    for (const failure of candidate.filterFailures || []) {
      target.failCounts[failure] = (target.failCounts[failure] || 0) + 1;
    }
    const side = candidate.side || "unknown";
    target.bySide[side] ||= { evaluated: 0, accepted: 0, rejected: 0, failCounts: {} };
    target.bySide[side].evaluated += 1;
    if (candidate.accepted) target.bySide[side].accepted += 1;
    else target.bySide[side].rejected += 1;
    for (const failure of candidate.filterFailures || []) {
      target.bySide[side].failCounts[failure] = (target.bySide[side].failCounts[failure] || 0) + 1;
    }
  }

  target.nearPassCandidates = [
    ...target.nearPassCandidates,
    ...candidates.filter((candidate) => !candidate.accepted).map(compactCandidate)
  ]
    .sort(compareNearPassCandidates)
    .slice(0, 20);
}

function scoreCandidateSide(snapshot, edge, side, sourceSignal = null) {
  const rsi = Number(snapshot.indicators.rsi || 50);
  const histogram = Number(snapshot.indicators.macdHistogram || 0);
  const volume = Number(snapshot.indicators.volumeRatio || 0);
  const edgeAligned = side === "long" ? edge : -edge;
  const reasons = [];
  // v2 优化：降低 edge 系数 0.8→0.5，提高基础分 42→48
  // 在 risk_off 市场 long 端 edgeAligned 常为负，原公式系统性压制 long 评分
  // 同时增加市场状态自适应：risk_off 时 short 加分，risk_on 时 long 加分
  const regimeBias = snapshot.marketRegime?.bias;
  let regimeBoost = 0;
  if (regimeBias === "risk_off" && side === "short") {
    regimeBoost = 10;
    reasons.push("risk_off 市场偏空加分");
  } else if (regimeBias === "risk_on" && side === "long") {
    regimeBoost = 10;
    reasons.push("risk_on 市场偏多加分");
  } else if (regimeBias === "risk_off" && side === "long") {
    regimeBoost = -8;
    reasons.push("risk_off 市场逆势减分");
  } else if (regimeBias === "risk_on" && side === "short") {
    regimeBoost = -8;
    reasons.push("risk_on 市场逆势减分");
  }
  let score = 48 + edgeAligned * 0.5 + regimeBoost;
  let technicalAligned = false;
  const sourceSignalScore = Number(sourceSignal?.score);
  const sourceSignalActionable = sourceSignal?.quality?.status === "actionable";
  if (Number.isFinite(sourceSignalScore) && sourceSignalActionable) {
    const sourceBoost = clamp(Math.round((sourceSignalScore - 60) / 3), 0, 12);
    score += sourceBoost;
    if (sourceBoost > 0) reasons.push(`signalEngine score ${sourceSignalScore}`);
    score += 4;
    reasons.push("signalEngine actionable");
    if (Number(sourceSignal?.riskReward || 0) >= 1.15) {
      score += 2;
      reasons.push(`source RR ${sourceSignal.riskReward}`);
    }
  } else if (sourceSignal) {
    reasons.push(`signalEngine ${sourceSignal?.quality?.status || "unreviewed"}`);
  }

  if (side === "long") {
    if (snapshot.directionAnalysis?.direction === "up") reasons.push("实时方向偏涨");
    if (snapshot.trend === "up" || snapshot.trend === "recovering") {
      score += 12;
      reasons.push(`趋势 ${snapshot.trend}`);
    }
    if (histogram > 0) {
      score += 8;
      reasons.push("MACD 柱线偏多");
    }
    if (rsi >= 45 && rsi <= 68) {
      score += 7;
      reasons.push("RSI 健康");
    }
    if (snapshot.technicalConsensus?.long?.allowed) {
      score += 10;
      technicalAligned = true;
      reasons.push("技术面多头共振");
    }
    if (snapshot.indicatorState?.breakoutBias === "bullish_fakeout_risk") score -= 12;
  } else {
    if (snapshot.directionAnalysis?.direction === "down") reasons.push("实时方向偏跌");
    if (snapshot.trend === "down" || snapshot.trend === "weakening") {
      score += 12;
      reasons.push(`趋势 ${snapshot.trend}`);
    }
    if (histogram < 0) {
      score += 8;
      reasons.push("MACD 柱线偏空");
    }
    if (rsi >= 32 && rsi <= 58) {
      score += 7;
      reasons.push("RSI 未极端超卖");
    }
    if (snapshot.technicalConsensus?.short?.allowed) {
      score += 10;
      technicalAligned = true;
      reasons.push("技术面空头共振");
    }
    if (snapshot.indicatorState?.breakoutBias === "bearish_fakeout_risk") score -= 12;
  }

  if (volume >= 1.2) {
    score += 5;
    reasons.push("成交量放大");
  }
  if (Number(snapshot.spreadPercent || 0) > 0.15) score -= 10;

  return {
    score: clamp(Math.round(score), 0, 100),
    technicalAligned,
    reasons
  };
}

async function openPosition(candidate, riskPlan) {
  const openedAt = new Date().toISOString();
  const maxHoldMinutes = normalizeMaxHoldMinutes(candidate.actionPlan?.maxHoldMinutes);
  return {
    ...candidate,
    id: `${candidate.symbol}:${candidate.side}:${Date.now()}`,
    openedAt,
    maxHoldMinutes,
    expiresAt: maxHoldMinutes
      ? new Date(Date.parse(openedAt) + Number(maxHoldMinutes) * 60_000).toISOString()
      : null,
    closedAt: null,
    status: "open",
    exitPrice: null,
    outcome: null,
    ...riskPlan,
    bestPrice: candidate.entryPrice,
    worstPrice: candidate.entryPrice,
    polls: []
  };
}

async function pollOpenPositions() {
  const updated = await mapWithConcurrency(state.positions, options.requestConcurrency, async (position) => {
    try {
      return await checkPosition(position);
    } catch (error) {
      recordError("position", error, { symbol: position.symbol });
      return position;
    }
  });

  state.positions = updated.filter((position) => position.status === "open");
  state.summary = summarizeTrades(state.trades);
}

async function checkPosition(position) {
  const book = await client.getOrderBookDepth("spot", position.symbol, 5);
  const exitPrice = executablePrice(book, position.side, "close") || position.entryPrice;
  const gross = grossReturnPercent(position.side, position.entryPrice, exitPrice);
  const next = updatePathStats(position, exitPrice, gross, book);

  if (isPositionExpired(position)) {
    return closePosition(next, "scalp_timeout", exitPrice);
  }

  if (position.side === "long") {
    if (exitPrice >= position.takeProfit) return closePosition(next, "tp", exitPrice);
    if (exitPrice <= position.stopLoss) return closePosition(next, "stop", exitPrice);
  } else {
    if (exitPrice <= position.takeProfit) return closePosition(next, "tp", exitPrice);
    if (exitPrice >= position.stopLoss) return closePosition(next, "stop", exitPrice);
  }

  return {
    ...next,
    unrealizedGrossReturnPercent: round(gross, 4)
  };
}

function isPositionExpired(position) {
  if (!normalizeMaxHoldMinutes(position.maxHoldMinutes)) return false;
  const expiresAt = Date.parse(position.expiresAt || "");
  return Number.isFinite(expiresAt) && Date.now() >= expiresAt;
}

function normalizeMaxHoldMinutes(value) {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

async function closeAllOpenPositions(outcome) {
  const closed = await mapWithConcurrency(state.positions, options.requestConcurrency, async (position) => {
    const book = await client.getOrderBookDepth("spot", position.symbol, 5);
    const exitPrice = executablePrice(book, position.side, "close") || position.entryPrice;
    const gross = grossReturnPercent(position.side, position.entryPrice, exitPrice);
    return closePosition(updatePathStats(position, exitPrice, gross, book), outcome, exitPrice);
  });
  state.positions = [];
  for (const item of closed) replaceTrade(item);
  state.summary = summarizeTrades(state.trades);
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
    ].slice(-500)
  };
}

function closePosition(position, outcome, exitPrice) {
  const gross = grossReturnPercent(position.side, position.entryPrice, exitPrice);
  const cost = estimateFormalRoundTripCost();
  const estimatedNet = gross - cost.totalCostPercent;
  const closed = {
    ...position,
    status: "closed",
    outcome,
    closedAt: new Date().toISOString(),
    exitPrice: round(exitPrice, 10),
    secondsHeld: Math.round((Date.now() - Date.parse(position.openedAt)) / 1000),
    grossReturnPercent: round(gross, 4),
    feePercent: cost.feePercent,
    slippagePercent: cost.slippagePercent,
    estimatedNetReturnPercent: round(estimatedNet, 4),
    netReturnPercent: round(estimatedNet, 4),
    realizedAccountReturnPercent: round(estimatedNet * Number(position.positionSizePercentOfEquity || 0) / 100, 4),
    netWin: estimatedNet > 0
  };
  replaceTrade(closed);
  // --- 风险护栏：止损触发后更新连续止损和最大回撤状态 ---
  if (closed.outcome === "stop") {
    updateConsecutiveStopPause();
  }
  updatePortfolioRiskGuard();
  console.log(`[formal-monitor] CLOSE ${closed.outcome.toUpperCase()} ${closed.symbol} action=${closed.actionPlan?.close || "close"} gross=${closed.grossReturnPercent}% net=${closed.estimatedNetReturnPercent}%`);
  queueFormalMonitorFeishuNotification("close", closed);
  return closed;
}

function replaceTrade(trade) {
  const index = state.trades.findIndex((item) => item.id === trade.id);
  if (index === -1) state.trades.push(trade);
  else state.trades[index] = trade;
}

function summarizeTrades(trades) {
  const closed = trades.filter((trade) => trade.status === "closed");
  const netWins = closed.filter((trade) => trade.netWin).length;
  const grossWins = closed.filter((trade) => Number(trade.grossReturnPercent || 0) > 0).length;
  const totalNet = closed.reduce((sum, trade) => sum + Number(trade.estimatedNetReturnPercent || 0), 0);
  const totalGross = closed.reduce((sum, trade) => sum + Number(trade.grossReturnPercent || 0), 0);
  const avgWin = mean(closed.filter((trade) => Number(trade.estimatedNetReturnPercent) > 0).map((trade) => Number(trade.estimatedNetReturnPercent)));
  const avgLossAbs = Math.abs(mean(closed.filter((trade) => Number(trade.estimatedNetReturnPercent) < 0).map((trade) => Number(trade.estimatedNetReturnPercent))) || 0);
  const performance = summarizePerformance(closed, (trade) => Number(trade.estimatedNetReturnPercent ?? 0));
  const accountPerformance = summarizePerformance(closed, realizedAccountReturnPercent);
  const portfolioRisk = calculatePortfolioRiskMetrics(closed);

  return {
    trades: trades.length,
    open: trades.filter((trade) => trade.status === "open").length,
    closed: closed.length,
    tp: closed.filter((trade) => trade.outcome === "tp").length,
    stop: closed.filter((trade) => trade.outcome === "stop").length,
    timeout: closed.filter((trade) => trade.outcome === "timeout" || trade.outcome === "scalp_timeout").length,
    scalpTimeout: closed.filter((trade) => trade.outcome === "scalp_timeout").length,
    grossWins,
    netWins,
    grossWinRate: closed.length ? round(grossWins / closed.length, 4) : null,
    netWinRate: closed.length ? round(netWins / closed.length, 4) : null,
    profitLossRatio: avgLossAbs ? round((avgWin || 0) / avgLossAbs, 4) : null,
    totalGrossReturnPercent: round(totalGross, 4),
    totalEstimatedNetReturnPercent: round(totalNet, 4),
    averageEstimatedNetReturnPercent: closed.length ? round(totalNet / closed.length, 4) : null,
    performance,
    accountPerformance,
    portfolioRisk,
    validation: validationStatusForTrades(closed, performance, accountPerformance),
    bySide: summarizeTradeGroups(closed, (trade) => trade.side),
    byStrategyGroup: summarizeTradeGroups(closed, (trade) => trade.strategyGroup || `${trade.side || "unknown"}:${options.signalInterval}`)
  };
}

function summarizeTradeGroups(trades, keyFn) {
  const groups = new Map();
  for (const trade of trades) {
    const key = keyFn(trade) || "unknown";
    const group = groups.get(key) || [];
    group.push(trade);
    groups.set(key, group);
  }

  return Object.fromEntries([...groups.entries()].map(([key, group]) => {
    const performance = summarizePerformance(group, (trade) => Number(trade.estimatedNetReturnPercent ?? 0));
    const accountPerformance = summarizePerformance(group, realizedAccountReturnPercent);
    const netWins = group.filter((trade) => trade.netWin).length;
    return [
      key,
      {
        total: group.length,
        tp: group.filter((trade) => trade.outcome === "tp").length,
        stop: group.filter((trade) => trade.outcome === "stop").length,
        timeout: group.filter((trade) => trade.outcome === "timeout" || trade.outcome === "scalp_timeout").length,
        scalpTimeout: group.filter((trade) => trade.outcome === "scalp_timeout").length,
        netWinRate: group.length ? round(netWins / group.length, 4) : 0,
        ...performance,
        accountPerformance,
        validation: validationStatusForTrades(group, performance, accountPerformance)
      }
    ];
  }));
}

function validationStatusForTrades(closed, performance, accountPerformance = performance) {
  const netWins = closed.filter((trade) => trade.netWin).length;
  const winRate = closed.length ? netWins / closed.length : 0;
  const passed = closed.length >= config.validation.minCompletedTrades
    && winRate >= config.validation.minWinRate
    && performance.expectancyPercent >= config.validation.minExpectancyPercent
    && accountPerformance.maxDrawdownPercent <= config.validation.maxDrawdownPercent;

  return {
    status: passed ? "passed" : "insufficient_or_failed",
    completedTrades: closed.length,
    netWinRate: round(winRate, 4),
    minCompletedTrades: config.validation.minCompletedTrades,
    minWinRate: config.validation.minWinRate,
    expectancyPercent: performance.expectancyPercent,
    minExpectancyPercent: config.validation.minExpectancyPercent,
    maxDrawdownPercent: accountPerformance.maxDrawdownPercent,
    allowedMaxDrawdownPercent: config.validation.maxDrawdownPercent
  };
}

function compactCandidate(candidate) {
  return {
    symbol: candidate.symbol,
    side: candidate.side,
    tradeStyle: candidate.tradeStyle || null,
    actionPlan: candidate.actionPlan || null,
    strategyGroup: candidate.strategyGroup,
    opportunityLayer: candidate.opportunityLayer || classifyOpportunityLayer(candidate),
    signalTier: candidate.signalTier || (candidate.accepted ? "formal" : "rejected"),
    watchOnly: Boolean(candidate.watchOnly),
    watchReason: candidate.watchReason || null,
    profileName: candidate.profileName,
    score: candidate.score,
    edge: candidate.directionEdge,
    edgeAligned: candidate.edgeAligned,
    accepted: candidate.accepted,
    filterFailures: candidate.filterFailures,
    hardFailures: candidate.hardFailures || [],
    softFailures: candidate.softFailures || [],
    tradeBlockers: candidate.tradeBlockers || [],
    margins: candidate.margins || null,
    nearPassScore: candidate.nearPassScore ?? null,
    technicalAligned: candidate.technicalAligned,
    confirmation: candidate.confirmation || null,
    volumeRatio: candidate.volumeRatio,
    atrPercent: candidate.atrPercent,
    spreadPercent: candidate.spreadPercent,
    priceChangePercent24h: candidate.priceChangePercent24h,
    entryPrice: candidate.entryPrice,
    takeProfit: candidate.takeProfit,
    stopLoss: candidate.stopLoss,
    targetPercent: candidate.targetPercent,
    stopPercent: candidate.stopPercent,
    roundTripCostPercent: candidate.roundTripCostPercent,
    netTargetPercent: candidate.netTargetPercent,
    rewardRisk: candidate.rewardRisk,
    candleWindow: candidate.candleWindow,
    candleChangePercent: candidate.candleChangePercent,
    liveCandle: candidate.liveCandle || null,
    timeframePlan: candidate.timeframePlan || null,
    timeframeAlignment: candidate.timeframeAlignment || null,
    momentumProfile: candidate.momentumProfile || null,
    scalpAlertProfile: candidate.scalpAlertProfile || null,
    scalpDecisionProfile: candidate.scalpDecisionProfile || null,
    technicalConsensus: compactTechnicalConsensus(candidate),
    indicatorState: candidate.indicatorState || null,
    evidence: (candidate.evidence || []).slice(0, 6),
    sourceSignal: candidate.sourceSignal || null,
    reasons: candidate.reasons,
    aiReview: candidate.aiReview || null
  };
}

function compactTechnicalConsensus(candidate) {
  const consensus = candidate.technicalConsensus;
  if (!consensus || !candidate.side) return null;
  const oppositeSide = candidate.side === "long" ? "short" : "long";
  return {
    bias: consensus.bias || null,
    side: consensus[candidate.side] || null,
    opposite: consensus[oppositeSide] || null
  };
}

function hasOpenPosition(symbol) {
  return state.positions.some((position) => position.symbol === symbol);
}

function isCoolingDown(candidate) {
  const latest = state.trades
    .filter((trade) => trade.symbol === candidate.symbol && trade.side === candidate.side)
    .map((trade) => Date.parse(trade.openedAt))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  return latest ? Date.now() - latest < options.cooldownMinutes * 60 * 1000 : false;
}

function closedTrades() {
  return state.trades.filter((trade) => trade.status === "closed");
}

function queueFormalMonitorFeishuNotification(type, trade) {
  if (!isFeishuEnabled()) return;
  if (type === "entry") {
    if (trade.feishuEntryQueuedAt) return;
    trade.feishuEntryQueuedAt = new Date().toISOString();
  } else if (type === "close") {
    if (trade.feishuCloseQueuedAt) return;
    trade.feishuCloseQueuedAt = new Date().toISOString();
  } else {
    return;
  }

  const text = type === "entry"
    ? buildFormalMonitorEntryFeishuText(trade)
    : buildFormalMonitorCloseFeishuText(trade);
  const eventLabel = type === "entry" ? "ENTRY" : "CLOSE";
  const promise = sendFeishuText(text)
    .then(() => {
      if (type === "entry") trade.feishuEntrySentAt = new Date().toISOString();
      else trade.feishuCloseSentAt = new Date().toISOString();
      console.log(`[formal-monitor][feishu] ${eventLabel}_SENT ${trade.symbol}`);
    })
    .catch((error) => {
      console.error(`[formal-monitor][feishu] ${eventLabel}_FAILED ${trade.symbol} ${sanitizeFeishuErrorMessage(error)}`);
    })
    .finally(() => {
      pendingFeishuNotifications.delete(promise);
    });

  pendingFeishuNotifications.add(promise);
}

async function flushPendingFeishuNotifications() {
  if (!pendingFeishuNotifications.size) return;
  await Promise.allSettled([...pendingFeishuNotifications]);
}

function buildFormalMonitorEntryFeishuText(position) {
  return [
    `[Bi-Agent] ${position.symbol || "-"} 实际开仓`,
    `币种：${position.symbol || "-"}`,
    "状态：实际开仓",
    `持仓方向：${position.side === "long" ? "多单" : "空单"}`,
    `执行动作：${entryActionLabel(position.side)}`,
    `入场价：${formatMonitorPrice(position.entryPrice)}`,
    `止盈价：${formatMonitorPrice(position.takeProfit)}`,
    `止损价：${formatMonitorPrice(position.stopLoss)}`,
    `信号评分：${formatMonitorValue(position.score)}`,
    `开仓时间：${position.openedAt || "-"}`
  ].join("\n");
}

function buildFormalMonitorCloseFeishuText(trade) {
  return [
    `[Bi-Agent] ${trade.symbol || "-"} 实际平仓`,
    `币种：${trade.symbol || "-"}`,
    "状态：实际平仓",
    `原持仓方向：${trade.side === "long" ? "多单" : "空单"}`,
    `执行动作：${closeActionLabel(trade.side)}`,
    `平仓原因：${closeReasonLabel(trade.outcome)}`,
    `入场价：${formatMonitorPrice(trade.entryPrice)}`,
    `退出价：${formatMonitorPrice(trade.exitPrice)}`,
    `毛收益率：${formatPercent(trade.grossReturnPercent)}`,
    `估算净收益率：${formatPercent(trade.estimatedNetReturnPercent)}`,
    `持仓时间：${formatHeldDuration(trade.secondsHeld)}`,
    `平仓时间：${trade.closedAt || "-"}`
  ].join("\n");
}

function entryActionLabel(side) {
  return side === "short" ? "卖出开空" : "买入开多";
}

function closeActionLabel(side) {
  return side === "short" ? "买回平空" : "卖出平多";
}

function closeReasonLabel(outcome) {
  if (outcome === "tp") return "止盈";
  if (outcome === "stop") return "止损";
  if (outcome === "scalp_timeout") return "短线持仓超时";
  if (outcome === "timeout") return "监控结束强制平仓";
  return outcome || "-";
}

function formatMonitorPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return String(round(number, number >= 100 ? 2 : number >= 1 ? 4 : 8));
}

function formatMonitorValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return String(round(number, 2));
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${round(number, 4)}%`;
}

function formatHeldDuration(seconds) {
  const totalSeconds = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时${minutes}分钟${remainingSeconds}秒`;
  if (minutes > 0) return `${minutes}分钟${remainingSeconds}秒`;
  return `${remainingSeconds}秒`;
}

function sanitizeFeishuErrorMessage(error) {
  const message = error?.message || String(error);
  return message.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
}

// ============================================================
// 风险护栏：连续止损暂停 + session 最大回撤保护
// ============================================================

function isRiskGuardPaused() {
  return activeRiskGuard(state.riskGuard);
}

function updateConsecutiveStopPause() {
  const recentClosed = state.trades
    .filter((t) => t.status === "closed")
    .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt))
    .slice(0, CONSECUTIVE_STOP_TRIGGER);
  if (recentClosed.length < CONSECUTIVE_STOP_TRIGGER) return;
  const allStopLoss = recentClosed.every((t) => t.outcome === "stop");
  if (allStopLoss) {
    const pauseUntil = new Date(Date.now() + CONSECUTIVE_STOP_PAUSE_MS).toISOString();
    state.riskGuard.consecutiveStopPauseUntil = pauseUntil;
    state.riskGuard.pauseEvents.push({
      type: "consecutive_stop_loss",
      triggeredAt: new Date().toISOString(),
      pauseUntil,
      recentSymbols: recentClosed.map((t) => t.symbol)
    });
    console.log(`[formal-monitor][risk-guard] CONSECUTIVE_STOP ${CONSECUTIVE_STOP_TRIGGER}x in a row → pause until ${pauseUntil} symbols=${recentClosed.map((t) => t.symbol).join(",")}`);
  }
}

function updatePortfolioRiskGuard() {
  const now = Date.now();
  const metrics = calculatePortfolioRiskMetrics(state.trades, { nowMs: now });
  state.riskGuard.sessionMaxDrawdownPercent = metrics.maxDrawdownPercent;

  if (!state.riskGuard.sessionHaltedAt && metrics.maxDrawdownPercent >= options.maxSessionDrawdownPercent) {
    const triggeredAt = new Date(now).toISOString();
    state.riskGuard.sessionHaltedAt = triggeredAt;
    state.riskGuard.pauseEvents.push({
      type: "session_max_drawdown",
      triggeredAt,
      maxDrawdownPercent: metrics.maxDrawdownPercent,
      limitPercent: options.maxSessionDrawdownPercent
    });
    console.log(`[formal-monitor][risk-guard] SESSION_HALT drawdown=${metrics.maxDrawdownPercent}% limit=${options.maxSessionDrawdownPercent}%`);
  }

  if (metrics.dailyAccountReturnPercent <= -options.maxDailyLossPercent) {
    const pauseUntil = nextUtcDayIso(now);
    if (state.riskGuard.dailyLossPauseUntil !== pauseUntil) {
      state.riskGuard.dailyLossPauseUntil = pauseUntil;
      state.riskGuard.pauseEvents.push({
        type: "daily_loss_limit",
        triggeredAt: new Date(now).toISOString(),
        pauseUntil,
        dailyAccountReturnPercent: metrics.dailyAccountReturnPercent,
        limitPercent: options.maxDailyLossPercent
      });
    }
  }
}

function recordEntryBlocks(candidate, blockers) {
  for (const blocker of blockers) {
    state.riskGuard.entryBlockCounts[blocker] = Number(state.riskGuard.entryBlockCounts[blocker] || 0) + 1;
  }
  state.riskGuard.lastBlockedCandidates = [
    ...state.riskGuard.lastBlockedCandidates,
    { symbol: candidate.symbol, side: candidate.side, blockers }
  ].slice(-10);
}

function persistState() {
  const snapshot = {
    ...state,
    summary: summarizeTrades(state.trades)
  };
  atomicWriteJson(state.outputPath, snapshot);
  atomicWriteJson(latestPath, snapshot);
  atomicWriteJson(runtimePath, snapshot);
}

function installShutdownCheckpoint() {
  const checkpointAndExit = async (signal) => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    try {
      persistState();
      console.log(`[formal-monitor] ${signal} received; runtime checkpoint saved.`);
      await flushPendingFeishuNotifications();
    } catch (error) {
      console.error(`[formal-monitor] failed to save checkpoint on ${signal}: ${error.message}`);
    }
    process.exit(0);
  };
  process.once("SIGTERM", () => void checkpointAndExit("SIGTERM"));
  process.once("SIGINT", () => void checkpointAndExit("SIGINT"));
}

function restoreRuntimeState() {
  // First deployment of persistent mode imports the old latest.json checkpoint so existing paper positions survive the upgrade.
  const checkpointPath = existsSync(runtimePath)
    ? runtimePath
    : existsSync(latestPath)
      ? latestPath
      : null;
  if (!checkpointPath) return;
  try {
    const recovered = safeJsonParse(readFileSync(checkpointPath, "utf8"), null);
    if (!recovered || !Array.isArray(recovered.positions) || !Array.isArray(recovered.trades)) {
      console.warn("[formal-monitor] runtime checkpoint is invalid; starting a new session.");
      return;
    }
    const { options: _savedOptions, ...savedState } = recovered;
    Object.assign(state, savedState, {
      persistenceVersion: 1,
      sessionDate: recovered.sessionDate || initialSessionDate,
      options,
      status: "running",
      finishedAt: null,
      outputPath: join(outputDir, sessionFileName(recovered.sessionDate || initialSessionDate)),
      recoveredAt: new Date().toISOString()
    });
    console.log(`[formal-monitor] recovered checkpoint source=${checkpointPath === runtimePath ? "runtime" : "latest"} session=${state.sessionDate} positions=${state.positions.length} trades=${state.trades.length}`);
  } catch (error) {
    console.warn(`[formal-monitor] failed to recover checkpoint: ${error.message}`);
  }
}

function rotateSessionIfNeeded() {
  const today = sessionDateKey(new Date(), options.timeZone);
  if (state.sessionDate === today) return;

  // Archive the previous day with its still-open positions intact before beginning the new daily report.
  state.status = "completed";
  state.finishedAt = new Date().toISOString();
  persistState();

  const previousSessionDate = state.sessionDate;
  const carriedPositions = state.positions.map((position) => ({
    ...position,
    carriedOver: true,
    carriedFromSession: previousSessionDate
  }));
  state.sessionDate = today;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.outputPath = join(outputDir, sessionFileName(today));
  state.status = "running";
  state.scanCount = 0;
  state.errors = [];
  state.trades = carriedPositions;
  state.signalConfirmations = {};
  state.summary = summarizeTrades(state.trades);
  state.riskGuard = {
    consecutiveStopPauseUntil: null,
    dailyLossPauseUntil: null,
    sessionHaltedAt: null,
    sessionMaxDrawdownPercent: 0,
    entryBlockCounts: {},
    lastBlockedCandidates: [],
    pauseEvents: []
  };
  console.log(`[formal-monitor] daily rollover ${previousSessionDate} -> ${today}; carried positions=${carriedPositions.length}`);
  persistState();
}

function recordError(scope, error, extra = {}) {
  const item = {
    at: new Date().toISOString(),
    scope,
    message: error?.message || String(error),
    ...extra
  };
  state.errors.push(item);
  state.errors = state.errors.slice(-100);
  console.warn(`[formal-monitor] ${scope} error: ${item.message}`);
}

function estimateFormalRoundTripCost() {
  const feePercent = Number(config.tradingCosts.futuresFeeRate || 0) * 2 * 100;
  const slippagePercent = Number(config.tradingCosts.slippagePercent || 0) * 2;
  return {
    feePercent: round(Math.max(0, feePercent), 4),
    slippagePercent: round(Math.max(0, slippagePercent), 4),
    totalCostPercent: round(Math.max(0, feePercent) + Math.max(0, slippagePercent), 4)
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

function mean(values) {
  const nums = values.filter(Number.isFinite);
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function extractOutputText(payload) {
  const texts = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) texts.push(content.text);
    }
  }
  return texts.join("\n");
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
  return ["1", "true", "yes", "y", "on"].includes(String(process.env[name]).trim().toLowerCase());
}

function readEnum(name, allowedValues, fallback) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  return allowedValues.includes(value) ? value : fallback;
}

function parseCsvList(value) {
  return uniqueValues(
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function uniqueValues(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function numberWithFallback(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseShadowProfiles(value) {
  return String(value || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item, index) => {
      const [namePart, settingsPart = ""] = item.includes(":")
        ? item.split(/:(.+)/)
        : [`profile_${index + 1}`, item];
      const profile = { name: (namePart || `profile_${index + 1}`).trim() };
      for (const pair of settingsPart.split(",")) {
        const [key, rawValue] = pair.split("=").map((part) => part?.trim());
        if (!key) continue;
        const number = Number(rawValue);
        if (Number.isFinite(number)) profile[key] = number;
      }
      return profile;
    });
}
