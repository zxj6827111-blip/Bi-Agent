import { createHmac } from "node:crypto";
import { config } from "./config.js";
import { round } from "./utils.js";

const sentAtByKey = new Map();
let tenantAccessTokenCache = null;

export function isFeishuEnabled() {
  const feishu = config.notifications?.feishu || {};
  if (!feishu.enabled) return false;
  return feishu.messageMode === "app"
    ? Boolean(feishu.appId && feishu.appSecret && feishu.receiveId)
    : Boolean(feishu.webhookUrl);
}

export async function notifyFeishuMarketAlerts(alerts = [], context = {}) {
  if (!isFeishuEnabled()) return [];
  const feishu = config.notifications.feishu;
  const allowedLevels = new Set(feishu.marketSignalLevels || ["formal"]);
  const selected = alerts
    .filter((alert) => allowedLevels.has(alert.signalLevel || "watch"))
    .filter((alert) => passesFeishuHighPrecision(alert, alert.marketSnapshot));

  return notifyBatch(selected, (alert) => ({
    key: marketAlertKey(alert),
    text: buildMarketAlertText(alert, context)
  }));
}

export async function notifyFeishuLifecycleAlerts(current = {}, alerts = []) {
  if (!isFeishuEnabled()) return [];
  const feishu = config.notifications.feishu;
  const allowedEvents = new Set(feishu.lifecycleEvents || ["open_signal", "entry", "close"]);
  const selected = alerts
    .filter((alert) => allowedEvents.has(alert.lifecycleType))
    .filter((alert) => passesFeishuHighPrecision(alert, current));

  return notifyBatch(selected, (alert) => ({
    key: lifecycleAlertKey(current, alert),
    text: buildLifecycleAlertText(current, alert)
  }));
}

export async function sendFeishuText(content) {
  const feishu = config.notifications?.feishu || {};
  if (feishu.messageMode === "app") return sendFeishuAppText(content);
  return sendFeishuWebhookText(content);
}

async function sendFeishuWebhookText(content) {
  const feishu = config.notifications?.feishu || {};
  if (!feishu.webhookUrl) return { skipped: true, reason: "missing_webhook" };

  const payload = {
    msg_type: "text",
    content: {
      text: content
    }
  };

  if (feishu.secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    payload.timestamp = timestamp;
    payload.sign = buildFeishuSignature(timestamp, feishu.secret);
  }

  if (feishu.dryRun) {
    console.info(`[feishu dry-run]\n${content}`);
    return { dryRun: true };
  }

  const response = await fetch(feishu.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload)
  });
  const bodyText = await response.text();
  const body = safeJson(bodyText);

  if (!response.ok) {
    throw new Error(`Feishu webhook HTTP ${response.status}: ${bodyText.slice(0, 200)}`);
  }

  const code = body?.code ?? body?.StatusCode ?? 0;
  if (Number(code) !== 0) {
    throw new Error(`Feishu webhook rejected: ${bodyText.slice(0, 200)}`);
  }

  return body || { ok: true };
}

export async function sendFeishuAppText(content) {
  const feishu = config.notifications?.feishu || {};
  if (!feishu.appId || !feishu.appSecret || !feishu.receiveId) {
    return { skipped: true, reason: "missing_app_credentials_or_receiver" };
  }

  if (feishu.dryRun) {
    console.info(`[feishu app dry-run]\n${content}`);
    return { dryRun: true };
  }

  const tenantAccessToken = await getTenantAccessToken(feishu);
  const response = await fetch(
    `${feishu.apiBaseUrl}/im/v1/messages?receive_id_type=${encodeURIComponent(feishu.receiveIdType)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${tenantAccessToken}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(buildFeishuAppMessagePayload(feishu.receiveId, content))
    }
  );
  const bodyText = await response.text();
  const body = safeJson(bodyText);

  if (!response.ok) {
    throw new Error(`Feishu app message HTTP ${response.status}: ${bodyText.slice(0, 200)}`);
  }

  if (Number(body?.code ?? 0) !== 0) {
    throw new Error(`Feishu app message rejected: ${bodyText.slice(0, 200)}`);
  }

  return body || { ok: true };
}

export function buildFeishuAppMessagePayload(receiveId, content) {
  return {
    receive_id: receiveId,
    msg_type: "text",
    content: JSON.stringify({ text: content })
  };
}

export function getTenantAccessTokenCacheExpiry(expiresInSeconds, now = Date.now()) {
  return now + Math.max(0, Number(expiresInSeconds || 0) - 60) * 1000;
}

async function getTenantAccessToken(feishu) {
  const now = Date.now();
  if (tenantAccessTokenCache?.expiresAt > now) return tenantAccessTokenCache.token;

  const response = await fetch(`${feishu.apiBaseUrl}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: feishu.appId, app_secret: feishu.appSecret })
  });
  const bodyText = await response.text();
  const body = safeJson(bodyText);

  if (!response.ok) {
    throw new Error(`Feishu tenant token HTTP ${response.status}: ${bodyText.slice(0, 200)}`);
  }
  if (Number(body?.code ?? 0) !== 0 || !body?.tenant_access_token) {
    throw new Error(`Feishu tenant token rejected: ${bodyText.slice(0, 200)}`);
  }

  tenantAccessTokenCache = {
    token: body.tenant_access_token,
    expiresAt: getTenantAccessTokenCacheExpiry(body.expire, now)
  };
  return tenantAccessTokenCache.token;
}

export function buildFeishuSignature(timestamp, secret) {
  const stringToSign = `${timestamp}\n${secret}`;
  return createHmac("sha256", stringToSign).update("").digest("base64");
}

export function buildMarketAlertText(alert = {}, context = {}) {
  const snapshot = alert.marketSnapshot || {};
  const price = alert.price ?? snapshot.price;
  const marketType = alert.marketType || snapshot.marketType;
  const actualMarketType = alert.actualMarketType || snapshot.actualMarketType;
  const title = `[Bi-Agent] ${alert.symbol || "-"} ${directionAction(alert.direction)} ${alert.statusLabel || "信号"}`;
  const lines = [
    title,
    `市场：${marketLabel(marketType, actualMarketType)} / 周期：${alert.timeframe || "-"}`,
    `当前价：${formatPrice(price)} / 评分：${formatValue(alert.score)} / RR：${formatValue(alert.riskReward)}`,
    directionLine(alert.directionAnalysis || snapshot.directionAnalysis),
    `入场区：${formatRange(alert.entryRange)}`,
    `止损：${formatPrice(alert.stopLoss)} / TP1：${formatPrice(alert.takeProfit?.tp1)} / TP2：${formatPrice(alert.takeProfit?.tp2)}`,
    `原因：${firstText(alert.reasons) || alert.classificationReason || alert.message || "-"}`,
    `扫描：${context.scope === "market" ? "全市场自动发现" : "手动扫描"}${context.scannedMarkets ? `，覆盖 ${context.scannedMarkets} 个标的` : ""}`
  ];

  if (alert.aiReview?.decision) {
    lines.push(`AI复核：${alert.aiReview.decision}${alert.aiReview.reason ? `，${alert.aiReview.reason}` : ""}`);
  }

  return lines.filter(Boolean).join("\n");
}

export function buildLifecycleAlertText(current = {}, alert = {}) {
  const rawDirection = alert.positionDirection || alert.originalDirection || alert.direction || current.position?.direction;
  const title = `[Bi-Agent] ${alert.symbol || current.symbol || "-"} ${lifecycleTitle(alert.lifecycleType, rawDirection)}`;
  const lines = [
    title,
    `动作：${alert.action || directionAction(rawDirection)}`,
    `当前价：${formatPrice(alert.price ?? current.price)} / 评分：${formatValue(alert.score)}`,
    directionLine(current.directionAnalysis),
    `入场区：${formatRange(alert.entryRange)}`,
    `止损：${formatPrice(alert.stopLoss)} / TP1：${formatPrice(alert.takeProfit?.tp1)} / TP2：${formatPrice(alert.takeProfit?.tp2)}`,
    `说明：${alert.message || alert.actionHint || "-"}`
  ];

  if (alert.lifecycleType === "close") {
    lines.push(`退出方向：${closeAction(rawDirection)}`);
  }

  return lines.filter(Boolean).join("\n");
}

async function notifyBatch(items, mapper) {
  const results = [];
  for (const item of items) {
    const message = mapper(item);
    if (!message.text || !shouldNotify(message.key)) {
      results.push({ skipped: true, key: message.key });
      continue;
    }

    try {
      const result = await sendFeishuText(message.text);
      results.push({ ok: true, key: message.key, result });
    } catch (error) {
      sentAtByKey.delete(message.key);
      console.warn(`[feishu notify failed] ${error.message}`);
      results.push({ ok: false, key: message.key, error: error.message });
    }
  }
  return results;
}

function shouldNotify(key) {
  const feishu = config.notifications?.feishu || {};
  const cooldownMs = Math.max(0, Number(feishu.cooldownMinutes || 0)) * 60 * 1000;
  const now = Date.now();
  cleanupSentCache(now, cooldownMs);
  const previous = sentAtByKey.get(key);
  if (previous && now - previous < cooldownMs) return false;
  sentAtByKey.set(key, now);
  return true;
}

export function passesFeishuHighPrecision(alert = {}, snapshot = {}) {
  const feishu = config.notifications?.feishu || {};
  if (!feishu.highPrecisionOnly) return true;

  const score = Number(alert.score || 0);
  const volumeRatio = Number(
    alert.volumeRatio
      ?? snapshot?.indicators?.volumeRatio
      ?? snapshot?.marketSnapshot?.indicators?.volumeRatio
      ?? 0
  );

  if (score >= Number(feishu.highPrecisionScore || 84)) return true;
  return volumeRatio >= Number(feishu.highPrecisionVolumeRatio || 1.5)
    && score >= Number(feishu.highPrecisionVolumeScore || 74);
}

function cleanupSentCache(now, cooldownMs) {
  if (sentAtByKey.size < 2000) return;
  for (const [key, value] of sentAtByKey.entries()) {
    if (now - value > cooldownMs) sentAtByKey.delete(key);
  }
}

export function marketAlertKey(alert = {}) {
  return [
    "market",
    alert.symbol,
    alert.marketType,
    alert.direction,
    alert.timeframe,
    alert.signalLevel
  ].join(":");
}

function lifecycleAlertKey(current = {}, alert = {}) {
  return [
    "lifecycle",
    current.symbol || alert.symbol,
    alert.lifecycleType,
    alert.id || alert.time,
    alert.positionDirection || alert.direction
  ].join(":");
}

function lifecycleTitle(type, direction) {
  if (type === "open_signal") return `${directionAction(direction)} 开仓提醒`;
  if (type === "entry") return `${directionAction(direction)} 入场触发`;
  if (type === "close") return `${closeAction(direction)} 提醒`;
  return `${directionAction(direction)} 提醒`;
}

function directionAction(direction) {
  if (direction === "long") return "合约开多";
  if (direction === "short") return "合约开空";
  if (direction === "spot_buy") return "现货买入";
  if (direction === "spot_sell") return "现货卖出/减仓";
  return "交易信号";
}

function closeAction(direction) {
  if (direction === "long") return "多单卖出/平仓";
  if (direction === "short") return "空单买回/平仓";
  if (direction === "spot_buy") return "现货卖出/退出";
  if (direction === "spot_sell") return "卖出观察结束";
  return "退出/平仓";
}

function directionLine(directionAnalysis = null) {
  if (!directionAnalysis?.direction) return null;
  const up = Number(directionAnalysis.probabilityUp);
  const down = Number(directionAnalysis.probabilityDown);
  const probabilities = Number.isFinite(up) && Number.isFinite(down)
    ? `上涨 ${Math.round(up * 100)}% / 下跌 ${Math.round(down * 100)}%`
    : "-";
  const evidence = (directionAnalysis.evidence || []).slice(0, 3).join("；");
  return `实时方向：${directionAnalysis.direction} / edgeScore ${formatValue(directionAnalysis.edgeScore)} / ${probabilities}${evidence ? ` / ${evidence}` : ""}`;
}

function marketLabel(marketType, actualMarketType) {
  if (marketType === actualMarketType || !actualMarketType) return marketType || "-";
  return `${marketType || "-"}(${actualMarketType})`;
}

function formatRange(range) {
  if (!Array.isArray(range) || range.length !== 2) return "-";
  return range.map((value) => formatPrice(value)).join(" - ");
}

function formatPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return String(round(number, number >= 100 ? 2 : number >= 1 ? 4 : 8));
}

function formatValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return String(round(number, 2));
}

function firstText(items) {
  return Array.isArray(items) ? items.find(Boolean) : null;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
