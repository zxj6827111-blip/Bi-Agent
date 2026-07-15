import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import {
  buildFeishuSignature,
  buildFeishuAppMessagePayload,
  buildLifecycleAlertText,
  buildMarketAlertText,
  getTenantAccessTokenCacheExpiry,
  marketAlertKey,
  passesFeishuHighPrecision
} from "../src/feishuNotifier.js";

test("buildFeishuSignature returns deterministic base64 hmac signature", () => {
  const left = buildFeishuSignature("1700000000", "test-secret");
  const right = buildFeishuSignature("1700000000", "test-secret");

  assert.equal(left, right);
  assert.match(left, /^[A-Za-z0-9+/=]+$/);
});

test("buildFeishuAppMessagePayload uses the application message API format", () => {
  assert.deepEqual(buildFeishuAppMessagePayload("oc_group", "signal text"), {
    receive_id: "oc_group",
    msg_type: "text",
    content: JSON.stringify({ text: "signal text" })
  });
});

test("getTenantAccessTokenCacheExpiry refreshes token one minute before expiry", () => {
  const now = 1_700_000_000_000;
  assert.equal(getTenantAccessTokenCacheExpiry(7_200, now), now + 7_140_000);
  assert.equal(getTenantAccessTokenCacheExpiry(30, now), now);
});

test("market alert cooldown key ignores prices that move between scans", () => {
  const base = {
    symbol: "BTCUSDT",
    marketType: "spot",
    direction: "long",
    timeframe: "4h",
    signalLevel: "watch"
  };
  const first = marketAlertKey({
    ...base,
    entryRange: [100, 100],
    stopLoss: 99,
    takeProfit: { tp1: 102 }
  });
  const nextScan = marketAlertKey({
    ...base,
    entryRange: [101, 101],
    stopLoss: 100,
    takeProfit: { tp1: 103 }
  });

  assert.equal(first, nextScan);
  assert.notEqual(first, marketAlertKey({ ...base, direction: "short" }));
  assert.notEqual(first, marketAlertKey({ ...base, signalLevel: "formal" }));
});

test("buildMarketAlertText includes entry, stop and target prices", () => {
  const text = buildMarketAlertText({
    symbol: "BTCUSDT",
    marketType: "futures",
    direction: "long",
    statusLabel: "正式短线点",
    timeframe: "15m",
    price: 100,
    score: 86,
    riskReward: 2.4,
    entryRange: [99, 101],
    stopLoss: 95,
    takeProfit: { tp1: 110, tp2: 120 },
    reasons: ["趋势、量能与AI共振"]
  }, {
    scope: "market",
    scannedMarkets: 80
  });

  assert.match(text, /BTCUSDT/);
  assert.match(text, /合约开多/);
  assert.match(text, /入场区：99 - 101/);
  assert.match(text, /止损：95/);
  assert.match(text, /TP1：110/);
  assert.match(text, /全市场自动发现/);
});

test("buildLifecycleAlertText maps long close to sell and close reminder", () => {
  const text = buildLifecycleAlertText({
    symbol: "BTCUSDT",
    price: 110
  }, {
    symbol: "BTCUSDT",
    lifecycleType: "close",
    positionDirection: "long",
    action: "合约开多TP1 平仓",
    price: 110,
    score: 86,
    entryRange: [99, 101],
    stopLoss: 95,
    takeProfit: { tp1: 110, tp2: 120 },
    message: "价格触达 TP1"
  });

  assert.match(text, /多单卖出\/平仓 提醒/);
  assert.match(text, /退出方向：多单卖出\/平仓/);
  assert.match(text, /价格触达 TP1/);
});

test("buildLifecycleAlertText maps short close to buy back reminder", () => {
  const text = buildLifecycleAlertText({}, {
    symbol: "ETHUSDT",
    lifecycleType: "close",
    positionDirection: "short",
    action: "合约开空TP1 平仓",
    price: 90,
    entryRange: [99, 101],
    stopLoss: 105,
    takeProfit: { tp1: 90, tp2: 80 },
    message: "价格触达 TP1"
  });

  assert.match(text, /空单买回\/平仓 提醒/);
  assert.match(text, /退出方向：空单买回\/平仓/);
});

test("passesFeishuHighPrecision keeps only strong default alerts", () => {
  const original = {
    highPrecisionOnly: config.notifications.feishu.highPrecisionOnly,
    highPrecisionScore: config.notifications.feishu.highPrecisionScore,
    highPrecisionVolumeRatio: config.notifications.feishu.highPrecisionVolumeRatio,
    highPrecisionVolumeScore: config.notifications.feishu.highPrecisionVolumeScore
  };

  Object.assign(config.notifications.feishu, {
    highPrecisionOnly: true,
    highPrecisionScore: 84,
    highPrecisionVolumeRatio: 1.5,
    highPrecisionVolumeScore: 74
  });

  try {
    assert.equal(passesFeishuHighPrecision({ score: 83, volumeRatio: 1.1 }), false);
    assert.equal(passesFeishuHighPrecision({ score: 84, volumeRatio: 1.1 }), true);
    assert.equal(passesFeishuHighPrecision({ score: 74, volumeRatio: 1.5 }), true);
  } finally {
    Object.assign(config.notifications.feishu, original);
  }
});
