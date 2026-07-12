import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAiReviewToMarketClassification,
  attachMarketSignalClassification,
  classifyMarketSignal,
  compareClassifiedMarketSignals,
  evaluateGlobalSignalFilter,
  marketSignalAction
} from "../src/marketSignalClassifier.js";

test("classifyMarketSignal marks 15m non-proxy actionable signal as formal", () => {
  const classification = classifyMarketSignal(makeSignal());

  assert.equal(classification.level, "formal");
  assert.equal(classification.statusLabel, "正式短线点");
  assert.equal(classification.isFormalShortTerm, true);
  assert.equal(marketSignalAction(makeSignal(), classification), "正式短线合约做多");
});

test("classifyMarketSignal downgrades 1h signals to watch candidates", () => {
  const classification = classifyMarketSignal(makeSignal({ timeframe: "1h" }));

  assert.equal(classification.level, "watch");
  assert.equal(classification.statusLabel, "观察候选");
  assert.match(classification.classificationReason, /15m/);
});

test("classifyMarketSignal downgrades futures proxy data to watch candidates", () => {
  const classification = classifyMarketSignal(makeSignal({
    marketSnapshot: {
      isFuturesProxy: true,
      fundingRate: null,
      quoteVolume: 100_000_000
    }
  }));

  assert.equal(classification.level, "watch");
  assert.match(classification.needsConfirmation.join(" "), /现货 K 线代理/);
});

test("classifyMarketSignal blocks signals that fail quality screening", () => {
  const classification = classifyMarketSignal(makeSignal({
    quality: {
      status: "filtered",
      problems: ["RR 不达标"]
    }
  }));

  assert.equal(classification.level, "blocked");
  assert.equal(classification.statusLabel, "已过滤");
});

test("applyAiReviewToMarketClassification only downgrades or blocks", () => {
  const formal = classifyMarketSignal(makeSignal());
  const watched = applyAiReviewToMarketClassification(formal, {
    decision: "watch",
    reason: "波动过大，先观察"
  });
  const blocked = applyAiReviewToMarketClassification(formal, {
    decision: "reject",
    reason: "多周期冲突"
  });

  assert.equal(watched.level, "watch");
  assert.equal(watched.statusLabel, "AI观察");
  assert.equal(blocked.level, "blocked");
  assert.equal(blocked.statusLabel, "AI拒绝");
});

test("compareClassifiedMarketSignals sorts formal before watch candidates", () => {
  const formalSignal = makeSignal({ score: 72 });
  const watchSignal = makeSignal({ timeframe: "1h", score: 90 });
  const rows = [
    { signal: watchSignal, classification: classifyMarketSignal(watchSignal) },
    { signal: formalSignal, classification: classifyMarketSignal(formalSignal) }
  ].sort(compareClassifiedMarketSignals);

  assert.equal(rows[0].classification.level, "formal");
});

test("attachMarketSignalClassification exposes fields for UI and persistence", () => {
  const signal = makeSignal();
  const classification = classifyMarketSignal(signal);
  const result = attachMarketSignalClassification(signal, classification, {
    source: "test-ai",
    summary: "通过",
    checklist: ["确认止损"],
    risk: ["控制仓位"],
    review: { decision: "pass", confidence: 0.7, reason: "通过" }
  });

  assert.equal(result.signalLevel, "formal");
  assert.equal(result.statusLabel, "正式短线点");
  assert.equal(result.aiSource, "test-ai");
  assert.equal(result.aiReview.decision, "pass");
});

test("global signal filter requires AI pass when requested", () => {
  const signal = makeSignal({
    aiSource: "local-rules",
    aiReview: { decision: "pass", confidence: 0.7, reason: "本地通过" },
    marketSnapshot: {
      isFuturesProxy: false,
      fundingRate: 0.0001,
      quoteVolume: 100_000_000,
      technicalConsensus: {
        long: { allowed: true, volumeConfirmed: true },
        short: { allowed: false, volumeConfirmed: false }
      }
    }
  });
  const classification = classifyMarketSignal(signal);
  const result = evaluateGlobalSignalFilter(signal, classification, { requireAiPass: true });

  assert.equal(result.passed, false);
  assert.ok(result.issues.some((item) => item.includes("AI")));
});

function makeSignal(overrides = {}) {
  return {
    id: "futures:BTCUSDT:15m:long",
    symbol: "BTCUSDT",
    marketType: "futures",
    direction: "long",
    directionLabel: "合约做多候选",
    timeframe: "15m",
    score: 78,
    riskReward: 2.1,
    marketSnapshot: {
      isFuturesProxy: false,
      fundingRate: 0.0001,
      quoteVolume: 100_000_000
    },
    quality: {
      status: "actionable",
      problems: []
    },
    ...overrides
  };
}
