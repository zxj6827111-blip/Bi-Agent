import { config } from "./config.js";
import { compactDirectionForAi } from "./directionEngine.js";
import { compactFusionForAi } from "./marketFusion.js";
import { safeJsonParse } from "./utils.js";

const SAFE_FALLBACK = {
  model: "local-rules"
};

export async function enrichSignalsWithAi(signals, onProgress = () => {}) {
  const selected = signals.slice(0, config.scan.maxAiSignals);
  const enriched = [];

  for (let index = 0; index < signals.length; index += 1) {
    const signal = signals[index];
    if (!selected.includes(signal)) {
      enriched.push(enrichWithLocalReview(signal));
      continue;
    }

    onProgress({
      current: index + 1,
      total: selected.length,
      symbol: signal.symbol,
      source: config.openaiApiKey ? config.openaiModel : SAFE_FALLBACK.model
    });
    const analysis = await analyzeSignal(signal);
    enriched.push({
      ...signal,
      aiSummary: analysis.summary,
      aiChecklist: analysis.checklist,
      aiRisk: analysis.risk,
      aiReview: analysis.review,
      aiSource: analysis.source
    });
  }

  return enriched.filter((signal) => signal.aiReview?.decision !== "reject");
}

export async function analyzeSignal(signal) {
  if (!config.openaiApiKey) {
    return localSignalAnalysis(signal);
  }

  try {
    const responsesUrl = config.openaiResponsesUrl || `${config.openaiBaseUrl}/responses`;
    const response = await fetch(responsesUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${config.openaiApiKey}`
      },
      body: JSON.stringify({
        model: config.openaiModel,
        instructions: [
          "你是虚拟货币量化信号二次审核模块，只根据输入 JSON 做判断。",
          "重点检查：趋势方向、成交量放大、MACD/RSI/Bollinger 三重确认、ATR 止损止盈、现货盘口与合约衍生品数据是否共振。",
          "当 trend_volume_ai_gate 中任一条件不满足，review.decision 必须是 watch 或 reject。",
          "当 futures_fusion.status 为 proxy 或 unavailable 时，合约方向不能给 pass。",
          "输出必须是 JSON，字段为 summary, checklist, risk, review；review.decision 只能是 pass, watch, reject。"
        ].join("\n"),
        input: JSON.stringify(buildSignalAiContext(signal)),
        text: {
          format: {
            type: "json_schema",
            name: "crypto_signal_analysis",
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["summary", "checklist", "risk", "review"],
              properties: {
                summary: { type: "string" },
                checklist: {
                  type: "array",
                  minItems: 3,
                  maxItems: 5,
                  items: { type: "string" }
                },
                risk: {
                  type: "array",
                  minItems: 2,
                  maxItems: 4,
                  items: { type: "string" }
                },
                review: {
                  type: "object",
                  additionalProperties: false,
                  required: ["decision", "confidence", "reason"],
                  properties: {
                    decision: { type: "string", enum: ["pass", "watch", "reject"] },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
                    reason: { type: "string" }
                  }
                }
              }
            },
            strict: true
          }
        },
        reasoning: { effort: "low" }
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API ${response.status}`);
    }

    const payload = await response.json();
    const text = payload.output_text || extractOutputText(payload);
    const parsed = safeJsonParse(text);
    if (!parsed?.summary || !Array.isArray(parsed.checklist) || !Array.isArray(parsed.risk) || !parsed.review?.decision) {
      throw new Error("AI JSON shape invalid");
    }

    return {
      source: config.openaiModel,
      summary: sanitizeAiText(parsed.summary),
      checklist: parsed.checklist.map(sanitizeAiText),
      risk: parsed.risk.map(sanitizeAiText),
      review: sanitizeReview(parsed.review, signal)
    };
  } catch (error) {
    return {
      ...localSignalAnalysis(signal),
      source: "local-rules-after-ai-error",
      summary: `${localSummary(signal)} AI 分析暂不可用：${error.message}`
    };
  }
}

export async function analyzeWatchState(watchState) {
  if (!config.openaiApiKey) {
    return {
      source: SAFE_FALLBACK.model,
      summary: localWatchSummary(watchState),
      action: watchState.alert?.action || "等待",
      checklist: [
        "等待价格接近入场区间再行动，避免追涨追空。",
        "先确认当前周期和更高周期方向没有明显冲突。",
        "严格按页面止损和失效条件执行。"
      ],
      risk: watchState.alert?.riskNotes || ["短线波动可能造成假突破或快速回撤。"]
    };
  }

  try {
    const responsesUrl = config.openaiResponsesUrl || `${config.openaiBaseUrl}/responses`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const response = await fetch(responsesUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${config.openaiApiKey}`
      },
      body: JSON.stringify({
        model: config.openaiModel,
        instructions: [
          "你是虚拟货币分时监控状态审核模块，只根据输入 JSON 做判断。",
          "根据当前行情、技术指标、支撑压力、规则信号、盘口和合约衍生品融合状态，判断当前分时状态。",
          "必须使用输入 alert.action 的动作名称，不要自行改成模糊的买入观察或卖出观察。",
          "现货卖出只代表减仓或卖出已有仓位，不代表做空；合约 short 才是做空观察。",
          "输出 JSON，字段为 summary, action, checklist, risk。"
        ].join("\n"),
        input: JSON.stringify(compactWatchState(watchState)),
        text: {
          format: {
            type: "json_schema",
            name: "crypto_watch_analysis",
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["summary", "action", "checklist", "risk"],
              properties: {
                summary: { type: "string" },
                action: { type: "string" },
                checklist: {
                  type: "array",
                  minItems: 3,
                  maxItems: 5,
                  items: { type: "string" }
                },
                risk: {
                  type: "array",
                  minItems: 2,
                  maxItems: 4,
                  items: { type: "string" }
                }
              }
            },
            strict: true
          }
        },
        reasoning: { effort: "low" }
      })
    });
    clearTimeout(timeout);

    if (!response.ok) throw new Error(`OpenAI API ${response.status}`);

    const payload = await response.json();
    const text = payload.output_text || extractOutputText(payload);
    const parsed = safeJsonParse(text);
    if (!parsed?.summary || !parsed?.action || !Array.isArray(parsed.checklist) || !Array.isArray(parsed.risk)) {
      throw new Error("AI watch JSON shape invalid");
    }

    return {
      source: config.openaiModel,
      summary: sanitizeAiText(parsed.summary),
      action: sanitizeAiText(parsed.action),
      checklist: parsed.checklist.map(sanitizeAiText),
      risk: parsed.risk.map(sanitizeAiText)
    };
  } catch (error) {
    return {
      source: "local-rules-after-ai-error",
      summary: `${localWatchSummary(watchState)} AI 分析暂不可用：${error.message}`,
      action: watchState.alert?.action || "等待",
      checklist: [
        "先按规则信号观察价格是否进入关键区间。",
        "AI 不可用时，不扩大仓位，不追涨追空。",
        "严格使用止损和失效条件。"
      ],
      risk: watchState.alert?.riskNotes || ["短线信号存在假突破风险。"]
    };
  }
}

function enrichWithLocalReview(signal) {
  const analysis = localSignalAnalysis(signal);
  return {
    ...signal,
    aiSummary: analysis.summary,
    aiChecklist: analysis.checklist,
    aiRisk: analysis.risk,
    aiReview: analysis.review,
    aiSource: analysis.source
  };
}

function localSignalAnalysis(signal) {
  return {
    source: SAFE_FALLBACK.model,
    summary: localSummary(signal),
    checklist: localChecklist(signal),
    risk: localRisk(signal),
    review: localReview(signal)
  };
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

function buildSignalAiContext(signal) {
  const snapshot = signal.marketSnapshot || {};
  const side = signal.direction === "short" || signal.direction === "spot_sell" ? "short" : "long";
  const consensus = side === "long" ? snapshot.technicalConsensus?.long : snapshot.technicalConsensus?.short;
  return {
    task: "crypto_signal_second_opinion",
    symbol: signal.symbol,
    market: {
      requestedType: signal.marketType,
      actualType: snapshot.actualMarketType || signal.marketType,
      dataSourceType: snapshot.dataSourceMarketType || signal.marketType,
      isFuturesProxy: Boolean(snapshot.isFuturesProxy),
      notice: snapshot.marketNotice || null
    },
    signal: {
      direction: signal.direction,
      side,
      timeframe: signal.timeframe,
      score: signal.score,
      ruleScore: signal.ruleScore ?? signal.score,
      riskReward: signal.riskReward,
      riskLevel: signal.riskLevel,
      entryRange: signal.entryRange,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      invalidCondition: signal.invalidCondition
    },
    price_action: {
      price: snapshot.price,
      trend: snapshot.trend,
      candleChangePercent: snapshot.candleChangePercent,
      volatilityPercent: snapshot.volatilityPercent,
      supportResistance: snapshot.supportResistance
    },
    technical_indicators: {
      values: snapshot.indicators,
      state: snapshot.indicatorState,
      consensus: snapshot.technicalConsensus,
      activeSideConsensus: consensus || null,
      reasons: signal.reasons || [],
      quality: signal.quality || null
    },
    market_microstructure: {
      spot: snapshot.spotContext || null,
      futures: snapshot.futuresContext || null,
      fusion: compactFusionForAi(snapshot.fusion || {}),
      realtimeDirection: compactDirectionForAi(snapshot.directionAnalysis || {})
    },
    trend_volume_ai_gate: {
      trendAligned: consensus?.trendAligned ?? null,
      volumeConfirmed: consensus?.volumeConfirmed ?? null,
      macdAligned: consensus?.macdAligned ?? null,
      rsiHealthy: consensus?.rsiHealthy ?? null,
      fakeBreakoutRisk: consensus?.fakeBreakoutRisk ?? null,
      ruleQuality: signal.quality?.status || null
    },
    risk_notes: signal.riskNotes || []
  };
}

function compactWatchState(watchState) {
  return {
    symbol: watchState.symbol,
    marketType: watchState.marketType,
    actualMarketType: watchState.actualMarketType,
    dataSourceMarketType: watchState.dataSourceMarketType,
    isFuturesProxy: watchState.isFuturesProxy,
    marketNotice: watchState.marketNotice,
    updatedAt: watchState.updatedAt,
    price: watchState.price,
    trend: watchState.trend,
    indicators: watchState.indicators,
    indicatorState: watchState.indicatorState,
    technicalConsensus: watchState.technicalConsensus,
    supportResistance: watchState.supportResistance,
    fundingRate: watchState.fundingRate,
    derivatives: watchState.derivatives,
    spotContext: watchState.spotContext,
    futuresContext: watchState.futuresContext,
    fusion: compactFusionForAi(watchState.fusion || {}),
    realtimeDirection: compactDirectionForAi(watchState.directionAnalysis || {}),
    recentLine: (watchState.line || []).slice(-24),
    alert: watchState.alert,
    signals: (watchState.signals || []).slice(0, 5).map((signal) => ({
      direction: signal.direction,
      timeframe: signal.timeframe,
      score: signal.score,
      entryRange: signal.entryRange,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      riskReward: signal.riskReward,
      reasons: signal.reasons,
      riskNotes: signal.riskNotes,
      quality: signal.quality
    }))
  };
}

function sanitizeAiText(text) {
  return String(text)
    .replace(/稳赚|保本|保证盈利|必赚|无风险/g, "不保证收益")
    .slice(0, 240);
}

function localSummary(signal) {
  const rr = signal.riskReward ? `，TP1 盈亏比约 ${signal.riskReward}` : "";
  return `${signal.symbol} 触发${signal.directionLabel}候选，评分 ${signal.score}/100，风险等级 ${signal.riskLevel}${rr}。`;
}

function localChecklist(signal) {
  return [
    `等待价格进入 ${signal.entryRange[0]} - ${signal.entryRange[1]} 区间，不追高追空。`,
    `止损参考 ${signal.stopLoss}，触发失效条件时放弃信号。`,
    `先观察 ${signal.timeframe} 周期是否继续配合成交量和趋势。`,
    "所有操作都应由人工确认，系统不自动下单。"
  ];
}

function localRisk(signal) {
  const risk = [...(signal.riskNotes || [])];
  risk.push("短线信号可能被插针、滑点、假突破影响。");
  return [...new Set(risk)].slice(0, 4);
}

function localReview(signal) {
  const problems = signal.quality?.problems || [];
  if (problems.length) {
    return {
      decision: "reject",
      confidence: 0.75,
      reason: problems.join("; ").slice(0, 240)
    };
  }

  if ((signal.riskReward || 0) < 1.5 || signal.riskLevel === "中高" || signal.riskLevel === "高") {
    return {
      decision: "watch",
      confidence: 0.62,
      reason: "信号通过基础规则，但风险收益比或风险等级仍需要人工二次确认。"
    };
  }

  return {
    decision: "pass",
    confidence: 0.68,
    reason: "信号通过基础规则、风险收益比和多周期质量筛选。"
  };
}

function sanitizeReview(review, signal) {
  const fallback = localReview(signal);
  const decision = ["pass", "watch", "reject"].includes(review?.decision) ? review.decision : fallback.decision;
  const confidence = Number(review?.confidence);
  return {
    decision,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : fallback.confidence,
    reason: sanitizeAiText(review?.reason || fallback.reason)
  };
}

function localWatchSummary(watchState) {
  const alert = watchState.alert;
  if (!alert || alert.direction === "wait") {
    return `${watchState.symbol} 当前没有明确买卖信号，建议继续等待。`;
  }
  return `${watchState.symbol} 当前状态：${alert.action}，评分 ${alert.score}/100，参考区间 ${alert.entryRange?.join(" - ") || "-"}。`;
}
