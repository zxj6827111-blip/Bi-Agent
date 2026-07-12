const FORMAL_ENTRY_TIMEFRAME = "15m";
const TRADE_DIRECTIONS = new Set(["spot_buy", "spot_sell", "long", "short"]);
const LONG_DIRECTIONS = new Set(["spot_buy", "long"]);
const SHORT_DIRECTIONS = new Set(["spot_sell", "short"]);

const DIRECTION_ACTION_TEXT = {
  spot_buy: "现货买入",
  spot_sell: "现货卖出/减仓",
  long: "合约做多",
  short: "合约做空"
};

const LEVEL_PRIORITY = {
  formal: 3,
  watch: 2,
  blocked: 0
};

export function classifyMarketSignal(signal = {}) {
  const reasons = [];
  const qualityStatus = signal.quality?.status || "actionable";
  const qualityProblems = signal.quality?.problems || [];
  const snapshot = signal.marketSnapshot || {};

  if (!TRADE_DIRECTIONS.has(signal.direction)) {
    return blockedClassification("不是可交易方向，已忽略。", qualityProblems);
  }

  if (qualityStatus !== "actionable") {
    return blockedClassification(
      qualityProblems[0] || "没有通过基础质量筛选。",
      qualityProblems
    );
  }

  if (signal.timeframe !== FORMAL_ENTRY_TIMEFRAME) {
    reasons.push(`${signal.timeframe || "-"} 只作为方向观察，正式短线点需要 15m 直接触发。`);
  }

  if (snapshot.isFuturesProxy || signal.isFuturesProxy) {
    reasons.push("合约接口不可用，当前使用现货 K 线代理，不能作为正式合约开仓点。");
  }

  if (signal.marketType === "futures" && (snapshot.fundingRate === null || snapshot.fundingRate === undefined)) {
    reasons.push("缺少合约资金费率，开仓前必须到交易所确认合约盘口和资金成本。");
  }

  if (reasons.length) {
    return {
      level: "watch",
      statusLabel: "观察候选",
      isFormalShortTerm: false,
      needsConfirmation: reasons,
      classificationReason: reasons[0],
      message: `${directionActionText(signal.direction)}候选，但还缺少短线正式入场确认。`
    };
  }

  return {
    level: "formal",
    statusLabel: "正式短线点",
    isFormalShortTerm: true,
    needsConfirmation: [],
    classificationReason: "15m 直接触发，并通过基础质量筛选。",
    message: `${directionActionText(signal.direction)}正式短线点，仍需按止损和仓位执行。`
  };
}

export function attachMarketSignalClassification(signal, classification, aiAnalysis = null) {
  return {
    ...signal,
    signalLevel: classification.level,
    statusLabel: classification.statusLabel,
    classificationReason: classification.classificationReason,
    needsConfirmation: classification.needsConfirmation,
    isFormalShortTerm: classification.isFormalShortTerm,
    aiSummary: aiAnalysis?.summary ?? signal.aiSummary,
    aiChecklist: aiAnalysis?.checklist ?? signal.aiChecklist,
    aiRisk: aiAnalysis?.risk ?? signal.aiRisk,
    aiReview: aiAnalysis?.review ?? signal.aiReview,
    aiSource: aiAnalysis?.source ?? signal.aiSource
  };
}

export function applyAiReviewToMarketClassification(classification, review = {}) {
  if (!review?.decision) return classification;
  const reason = review.reason ? `AI 二次审核：${review.reason}` : "AI 二次审核要求继续观察。";

  if (review.decision === "reject") {
    return {
      ...classification,
      level: "blocked",
      statusLabel: "AI拒绝",
      isFormalShortTerm: false,
      needsConfirmation: [reason, ...(classification.needsConfirmation || [])],
      classificationReason: reason,
      message: "AI 二次审核拒绝该信号，已从全局提醒中隐藏。"
    };
  }

  if (review.decision === "watch" && classification.level === "formal") {
    return {
      ...classification,
      level: "watch",
      statusLabel: "AI观察",
      isFormalShortTerm: false,
      needsConfirmation: [reason],
      classificationReason: reason,
      message: "规则达到正式点，但 AI 二次审核要求先观察。"
    };
  }

  if (review.decision === "watch") {
    return {
      ...classification,
      needsConfirmation: [reason, ...(classification.needsConfirmation || [])],
      classificationReason: classification.classificationReason || reason
    };
  }

  return classification;
}

export function compareClassifiedMarketSignals(a, b) {
  const left = normalizeClassifiedItem(a);
  const right = normalizeClassifiedItem(b);
  const priorityDiff = (LEVEL_PRIORITY[right.classification.level] || 0) - (LEVEL_PRIORITY[left.classification.level] || 0);
  if (priorityDiff) return priorityDiff;
  const scoreDiff = Number(right.signal.score || 0) - Number(left.signal.score || 0);
  if (scoreDiff) return scoreDiff;
  const rrDiff = Number(right.signal.riskReward || 0) - Number(left.signal.riskReward || 0);
  if (rrDiff) return rrDiff;
  return Number(right.signal.marketSnapshot?.quoteVolume || 0) - Number(left.signal.marketSnapshot?.quoteVolume || 0);
}

export function evaluateGlobalSignalFilter(signal, classification = classifyMarketSignal(signal), { requireAiPass = false } = {}) {
  const issues = [];
  const snapshot = signal?.marketSnapshot || {};
  const bias = signalSideClass(signal?.direction);
  const sideConsensus = bias === "long"
    ? snapshot.technicalConsensus?.long
    : bias === "short"
      ? snapshot.technicalConsensus?.short
      : null;

  if (classification.level !== "formal") {
    issues.push(classification.classificationReason || "信号未达到正式提醒级别。");
  }

  if (sideConsensus && !sideConsensus.allowed) {
    issues.push("趋势、MACD、RSI、Bollinger 与成交量没有形成同向共振。");
  }

  if (snapshot.technicalConsensus && sideConsensus && !sideConsensus.volumeConfirmed) {
    issues.push("成交量没有放大，信号纯度不足。");
  }

  if (snapshot.directionAnalysis && snapshot.directionAnalysis.status !== "unavailable") {
    const edge = Number(snapshot.directionAnalysis.edgeScore || 0);
    const alignedEdge = bias === "long" ? edge : bias === "short" ? -edge : 0;
    if (alignedEdge < 35) {
      issues.push(`实时方向引擎没有形成同向优势，edgeScore ${edge}。`);
    }
  }

  if (snapshot.fusion && snapshot.marketType === "futures") {
    const fusionSideScore = bias === "long" ? Number(snapshot.fusion.longScore || 0) : Number(snapshot.fusion.shortScore || 0);
    if (snapshot.fusion.status === "proxy" || snapshot.fusion.status === "unavailable") {
      issues.push("合约融合数据不可用，不能输出正式合约全局提醒。");
    }
    if (fusionSideScore < -4) {
      issues.push("现货盘口与合约衍生指标不支持当前方向。");
    }
  }

  if (requireAiPass && (signal?.aiReview?.decision !== "pass" || String(signal?.aiSource || "").startsWith("local-rules"))) {
    issues.push(signal?.aiReview?.reason ? `AI 未通过：${signal.aiReview.reason}` : "AI 未给出 pass 结论。");
  }

  return {
    passed: issues.length === 0,
    issues
  };
}

export function passesGlobalSignalFilter(signal, classification = classifyMarketSignal(signal), options = {}) {
  return evaluateGlobalSignalFilter(signal, classification, options).passed;
}

export function directionActionText(direction) {
  return DIRECTION_ACTION_TEXT[direction] || direction || "信号";
}

export function marketSignalAction(signal, classification) {
  const actionText = directionActionText(signal.direction);
  if (classification.level === "formal") return `正式短线${actionText}`;
  if (classification.level === "watch") return `观察候选：${actionText}`;
  return `已过滤：${actionText}`;
}

export function signalSideClass(direction) {
  if (LONG_DIRECTIONS.has(direction)) return "long";
  if (SHORT_DIRECTIONS.has(direction)) return "short";
  return "wait";
}

function blockedClassification(reason, problems = []) {
  return {
    level: "blocked",
    statusLabel: "已过滤",
    isFormalShortTerm: false,
    needsConfirmation: problems,
    classificationReason: reason,
    message: reason
  };
}

function normalizeClassifiedItem(item) {
  if (item?.signal && item?.classification) return item;
  return {
    signal: item || {},
    classification: classifyMarketSignal(item || {})
  };
}
