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
    requestTimeoutMs: Number(process.env.BINANCE_REQUEST_TIMEOUT_MS || 8_000)
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
