import { loadEnvFile } from "./env.js";

loadEnvFile();

export const config = {
  port: Number(process.env.PORT || 4173),
  host: process.env.HOST || "127.0.0.1",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-5.5",
  openaiBaseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
  openaiResponsesUrl: process.env.OPENAI_RESPONSES_URL || "",
  scan: {
    topSymbolsPerMarket: Number(process.env.TOP_SYMBOLS_PER_MARKET || 24),
    maxAiSignals: Number(process.env.MAX_AI_SIGNALS || 12),
    intervals: ["15m", "1h", "4h"],
    klineLimit: 120,
    minQuoteVolume: Number(process.env.MIN_QUOTE_VOLUME || 15_000_000),
    maxSpreadPercent: Number(process.env.MAX_SPREAD_PERCENT || 0.35),
    requestConcurrency: Number(process.env.REQUEST_CONCURRENCY || 6)
  },
  marketWatch: {
    maxSymbols: Number(process.env.MARKET_WATCH_MAX_SYMBOLS || 80),
    signalLimit: Number(process.env.MARKET_WATCH_SIGNAL_LIMIT || 30),
    aiReviewLimit: Number(process.env.MARKET_WATCH_AI_REVIEW_LIMIT || 3),
    intervals: ["15m", "1h", "4h"],
    klineLimit: 120,
    minRefreshSeconds: Number(process.env.MARKET_WATCH_MIN_REFRESH_SECONDS || 60),
    requestConcurrency: Number(process.env.MARKET_WATCH_REQUEST_CONCURRENCY || 4)
  },
  binance: {
    spotBaseUrl: process.env.BINANCE_SPOT_BASE_URL || "https://data-api.binance.vision",
    futuresBaseUrl: process.env.BINANCE_FUTURES_BASE_URL || "https://fapi.binance.com",
    spotBaseUrls: parseUrlList(
      process.env.BINANCE_SPOT_BASE_URLS || process.env.BINANCE_SPOT_BASE_URL || "https://data-api.binance.vision"
    ),
    futuresBaseUrls: parseUrlList(
      process.env.BINANCE_FUTURES_BASE_URLS || process.env.BINANCE_FUTURES_BASE_URL || "https://fapi.binance.com"
    ),
    requestTimeoutMs: Number(process.env.BINANCE_REQUEST_TIMEOUT_MS || 8_000),
    requestRetryCount: Number(process.env.BINANCE_REQUEST_RETRY_COUNT || 1),
    requestRetryBaseDelayMs: Number(process.env.BINANCE_REQUEST_RETRY_BASE_DELAY_MS || 250),
    metadataCacheMs: Number(process.env.BINANCE_METADATA_CACHE_MS || 6 * 60 * 60_000),
    metadataStaleMs: Number(process.env.BINANCE_METADATA_STALE_MS || 24 * 60 * 60_000)
  },
  pumpRadar: {
    outputDir: process.env.PUMP_RADAR_OUTPUT_DIR || "",
    durationSeconds: Number(process.env.PUMP_RADAR_DURATION_SECONDS || 0),
    snapshotSeconds: Number(process.env.PUMP_RADAR_SNAPSHOT_SECONDS || 30),
    candidateRefreshSeconds: Number(process.env.PUMP_RADAR_CANDIDATE_REFRESH_SECONDS || 30),
    streamUrl: (process.env.BINANCE_FUTURES_STREAM_URL || "wss://fstream.binance.com").replace(/\/+$/, ""),
    streamStaleSeconds: Number(process.env.PUMP_RADAR_STREAM_STALE_SECONDS || 8),
    maxUniverseSymbols: Number(process.env.PUMP_RADAR_MAX_UNIVERSE_SYMBOLS || 1_000),
    minQuoteVolume: Number(process.env.PUMP_RADAR_MIN_QUOTE_VOLUME || 5_000_000),
    minDiscoveryBookNotional: Number(process.env.PUMP_RADAR_MIN_DISCOVERY_BOOK_NOTIONAL || 500),
    maxCandidates: Number(process.env.PUMP_RADAR_MAX_CANDIDATES || 12),
    move10sPercent: Number(process.env.PUMP_RADAR_MOVE_10S_PERCENT || 1.2),
    move30sPercent: Number(process.env.PUMP_RADAR_MOVE_30S_PERCENT || 2),
    move60sPercent: Number(process.env.PUMP_RADAR_MOVE_60S_PERCENT || 3),
    watchMinSeconds: Number(process.env.PUMP_RADAR_WATCH_MIN_SECONDS || 3),
    watchMaxSeconds: Number(process.env.PUMP_RADAR_WATCH_MAX_SECONDS || 20),
    minConfirmScore: Number(process.env.PUMP_RADAR_MIN_CONFIRM_SCORE || 70),
    maxSpreadPercent: Number(process.env.PUMP_RADAR_MAX_SPREAD_PERCENT || 0.25),
    minTopBookNotional: Number(process.env.PUMP_RADAR_MIN_TOP_BOOK_NOTIONAL || 15_000),
    minTradeQuote: Number(process.env.PUMP_RADAR_MIN_TRADE_QUOTE || 10_000),
    minBuyRatio: Number(process.env.PUMP_RADAR_MIN_BUY_RATIO || 0.58),
    minDepthImbalance: Number(process.env.PUMP_RADAR_MIN_DEPTH_IMBALANCE || -0.2),
    maxEntryChasePercent: Number(process.env.PUMP_RADAR_MAX_ENTRY_CHASE_PERCENT || 1.5),
    cooldownSeconds: Number(process.env.PUMP_RADAR_COOLDOWN_SECONDS || 600),
    crossVenueEnabled: parseBoolean(process.env.PUMP_RADAR_CROSS_VENUE_ENABLED, true),
    crossVenueStrict: parseBoolean(process.env.PUMP_RADAR_CROSS_VENUE_STRICT, false),
    crossVenueRequired: Number(process.env.PUMP_RADAR_CROSS_VENUE_REQUIRED || 1),
    crossVenueMinMovePercent: Number(process.env.PUMP_RADAR_CROSS_VENUE_MIN_MOVE_PERCENT || 0.03),
    paperNotional: Number(process.env.PUMP_RADAR_PAPER_NOTIONAL || 1_000),
    maxOpenPositions: Number(process.env.PUMP_RADAR_MAX_OPEN_POSITIONS || 3),
    initialStopPercent: Number(process.env.PUMP_RADAR_INITIAL_STOP_PERCENT || 0.7),
    takeProfitPercent: Number(process.env.PUMP_RADAR_TAKE_PROFIT_PERCENT || 2.5),
    trailingActivationPercent: Number(process.env.PUMP_RADAR_TRAILING_ACTIVATION_PERCENT || 0.8),
    trailingDistancePercent: Number(process.env.PUMP_RADAR_TRAILING_DISTANCE_PERCENT || 0.45),
    momentumExitPercent: Number(process.env.PUMP_RADAR_MOMENTUM_EXIT_PERCENT || -0.25),
    maxHoldSeconds: Number(process.env.PUMP_RADAR_MAX_HOLD_SECONDS || 300),
    notifyEvents: parseCsv(process.env.PUMP_RADAR_NOTIFY_EVENTS || "confirmed,entry,exit,source_degraded,source_recovered")
  },
  tradingCosts: {
    spotFeeRate: Number(process.env.SPOT_FEE_RATE || 0.001),
    futuresFeeRate: Number(process.env.FUTURES_FEE_RATE || 0.0005),
    slippagePercent: Number(process.env.ASSUMED_SLIPPAGE_PERCENT || 0.05)
  },
  validation: {
    minCompletedTrades: Number(process.env.MIN_VALIDATION_TRADES || 30),
    minWinRate: Number(process.env.MIN_VALIDATION_WIN_RATE || 0.5),
    minExpectancyPercent: Number(process.env.MIN_VALIDATION_EXPECTANCY_PERCENT || 0),
    maxDrawdownPercent: Number(process.env.MAX_VALIDATION_DRAWDOWN_PERCENT || 8)
  },
  direction: {
    enabled: parseBoolean(process.env.DIRECTION_ENGINE_ENABLED, true),
    depthLimit: Number(process.env.DIRECTION_DEPTH_LIMIT || 50),
    aggTradeLimit: Number(process.env.DIRECTION_AGG_TRADE_LIMIT || 500),
    minFormalEdge: Number(process.env.DIRECTION_MIN_FORMAL_EDGE || 35),
    contradictionEdge: Number(process.env.DIRECTION_CONTRADICTION_EDGE || 25)
  },
  notifications: {
    feishu: {
      messageMode: parseFeishuMessageMode(process.env.FEISHU_MESSAGE_MODE),
      webhookUrl: process.env.FEISHU_WEBHOOK_URL || "",
      secret: process.env.FEISHU_SECRET || "",
      appId: process.env.FEISHU_APP_ID || "",
      appSecret: process.env.FEISHU_APP_SECRET || "",
      receiveIdType: process.env.FEISHU_RECEIVE_ID_TYPE || "chat_id",
      receiveId: process.env.FEISHU_RECEIVE_ID || "",
      apiBaseUrl: (process.env.FEISHU_API_BASE_URL || "https://open.feishu.cn/open-apis").replace(/\/+$/, ""),
      enabled: parseBoolean(
        process.env.FEISHU_ENABLED,
        Boolean(process.env.FEISHU_WEBHOOK_URL || (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET && process.env.FEISHU_RECEIVE_ID))
      ),
      dryRun: parseBoolean(process.env.FEISHU_DRY_RUN, false),
      marketSignalLevels: parseCsv(process.env.FEISHU_MARKET_SIGNAL_LEVELS || "formal"),
      lifecycleEvents: parseCsv(process.env.FEISHU_LIFECYCLE_EVENTS || "open_signal,entry,close"),
      highPrecisionOnly: parseBoolean(process.env.FEISHU_HIGH_PRECISION_ONLY, true),
      highPrecisionScore: Number(process.env.FEISHU_HIGH_PRECISION_SCORE || 84),
      highPrecisionVolumeRatio: Number(process.env.FEISHU_HIGH_PRECISION_VOLUME_RATIO || 1.5),
      highPrecisionVolumeScore: Number(process.env.FEISHU_HIGH_PRECISION_VOLUME_SCORE || 74),
      cooldownMinutes: Number(process.env.FEISHU_NOTIFY_COOLDOWN_MINUTES || 60)
    }
  }
};

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
}

function parseCsv(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseUrlList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function parseFeishuMessageMode(value) {
  return String(value || "webhook").trim().toLowerCase() === "app" ? "app" : "webhook";
}
