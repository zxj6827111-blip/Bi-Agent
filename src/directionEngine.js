import { config } from "./config.js";
import { clamp, round } from "./utils.js";

const LONG_DIRECTIONS = new Set(["spot_buy", "long"]);
const SHORT_DIRECTIONS = new Set(["spot_sell", "short"]);

export function buildMarketRegime({ spotMarkets = [], futuresMarkets = [], preferredMarketType = "auto" } = {}) {
  const source = preferredMarketType === "futures" && futuresMarkets.length
    ? futuresMarkets
    : spotMarkets.length
      ? spotMarkets
      : futuresMarkets;
  const markets = source.filter((item) => Number.isFinite(Number(item.priceChangePercent)) && Number(item.quoteVolume) > 0);
  const totalVolume = markets.reduce((sum, item) => sum + Number(item.quoteVolume || 0), 0);
  const advancers = markets.filter((item) => Number(item.priceChangePercent) > 0).length;
  const decliners = markets.filter((item) => Number(item.priceChangePercent) < 0).length;
  const volumeWeightedChangePercent = totalVolume
    ? markets.reduce((sum, item) => sum + Number(item.priceChangePercent || 0) * Number(item.quoteVolume || 0), 0) / totalVolume
    : 0;
  const btc = findMarket(source, "BTCUSDT");
  const eth = findMarket(source, "ETHUSDT");
  const anchorChangePercent = meanFinite([
    Number(btc?.priceChangePercent),
    Number(eth?.priceChangePercent)
  ]) ?? volumeWeightedChangePercent;
  const breadth = markets.length ? (advancers - decliners) / markets.length : 0;
  const score = clamp(
    Math.round(volumeWeightedChangePercent * 5 + anchorChangePercent * 4 + breadth * 45),
    -100,
    100
  );

  return {
    status: markets.length ? "ok" : "unavailable",
    sourceMarketType: preferredMarketType,
    totalMarkets: markets.length,
    advancers,
    decliners,
    advanceDeclineRatio: markets.length ? round(advancers / markets.length, 4) : null,
    volumeWeightedChangePercent: round(volumeWeightedChangePercent, 4),
    anchorChangePercent: round(anchorChangePercent, 4),
    btcChangePercent: round(Number(btc?.priceChangePercent), 4),
    ethChangePercent: round(Number(eth?.priceChangePercent), 4),
    score,
    bias: score >= 20 ? "risk_on" : score <= -20 ? "risk_off" : "neutral"
  };
}

export function enrichMarketWithDirection({ market, microstructure = null, regime = null }) {
  const directionAnalysis = buildDirectionAnalysis({ market, microstructure, regime });
  return {
    ...market,
    microstructure: compactMicrostructure(microstructure),
    marketRegime: regime || null,
    directionAnalysis
  };
}

export function buildDirectionAnalysis({ market = {}, microstructure = null, regime = null } = {}) {
  const orderBook = summarizeOrderBook(microstructure?.orderBook);
  const flow = summarizeAggressiveTrades(microstructure?.aggressiveTrades);
  const relative = summarizeRelativeStrength(market, regime);
  const derivatives = summarizeDerivatives(market);
  const dataQuality = computeDataQuality({ microstructure, orderBook, flow, regime, market });

  // v2 优化：降低 marketRegime 权重 0.20→0.15（减少 risk_off/risk_on 的恒定拖拽）
  // 提高 aggressiveFlow 权重 0.30→0.35（实时买卖流更 actionable）
  const weightedEdge =
    orderBook.score * 0.25
    + flow.score * 0.35
    + Number(regime?.score || 0) * 0.15
    + relative.score * 0.15
    + derivatives.score * 0.10;
  const edgeScore = clamp(Math.round(weightedEdge * dataQuality.weight), -100, 100);
  const probabilityUp = probabilityFromEdge(edgeScore);
  const probabilityDown = round(1 - probabilityUp, 4);
  const minFormalEdge = Number(config.direction?.minFormalEdge || 35);
  const direction = edgeScore >= minFormalEdge
    ? "up"
    : edgeScore <= -minFormalEdge
      ? "down"
      : "neutral";

  return {
    status: dataQuality.status,
    direction,
    edgeScore,
    probabilityUp,
    probabilityDown,
    confidence: round(Math.abs(probabilityUp - 0.5) * 2 * dataQuality.weight, 4),
    components: {
      orderBook,
      aggressiveFlow: flow,
      marketRegime: regime ? {
        bias: regime.bias,
        score: regime.score,
        advanceDeclineRatio: regime.advanceDeclineRatio,
        volumeWeightedChangePercent: regime.volumeWeightedChangePercent,
        anchorChangePercent: regime.anchorChangePercent
      } : null,
      relativeStrength: relative,
      derivatives
    },
    evidence: buildEvidence({ edgeScore, orderBook, flow, regime, relative, derivatives }),
    dataQuality
  };
}

export function directionScoreAdjustment(directionAnalysis, direction) {
  if (!directionAnalysis || directionAnalysis.status === "unavailable") return 0;
  const side = directionSide(direction);
  if (side === "neutral") return 0;
  const edge = Number(directionAnalysis.edgeScore || 0);
  const aligned = side === "long" ? edge : -edge;
  return clamp(Math.round(aligned / 5), -18, 18);
}

export function directionBlocksSignal(directionAnalysis, direction) {
  const blockers = [];
  if (!directionAnalysis || directionAnalysis.status === "unavailable") return blockers;

  const side = directionSide(direction);
  if (side === "neutral") return blockers;
  const edge = Number(directionAnalysis.edgeScore || 0);
  const contradictionEdge = Number(config.direction?.contradictionEdge || 25);
  const aligned = side === "long" ? edge : -edge;

  if (aligned <= -contradictionEdge) {
    blockers.push(`实时方向引擎与信号相反：edgeScore ${edge}，方向 ${directionAnalysis.direction}`);
  }

  const minFormalEdge = Number(config.direction?.minFormalEdge || 35);
  if (Math.abs(edge) < minFormalEdge && directionAnalysis.dataQuality?.status === "ok") {
    blockers.push(`实时买卖流和盘口优势不足：edgeScore ${edge} 未达到 ${minFormalEdge}`);
  }

  return blockers;
}

export function compactDirectionForAi(directionAnalysis = {}) {
  return {
    status: directionAnalysis.status,
    direction: directionAnalysis.direction,
    edgeScore: directionAnalysis.edgeScore,
    probabilityUp: directionAnalysis.probabilityUp,
    probabilityDown: directionAnalysis.probabilityDown,
    confidence: directionAnalysis.confidence,
    components: directionAnalysis.components,
    evidence: directionAnalysis.evidence
  };
}

function summarizeOrderBook(orderBook = null) {
  if (!orderBook) {
    return {
      status: "unavailable",
      score: 0,
      imbalance: null,
      bidNotional: null,
      askNotional: null,
      spreadPercent: null,
      largestBidWallDistancePercent: null,
      largestAskWallDistancePercent: null
    };
  }

  const imbalance = Number(orderBook.imbalance);
  const wallScore = wallPressureScore(orderBook);
  const spreadPenalty = Number(orderBook.spreadPercent || 0) > 0.08 ? 8 : 0;
  const score = clamp(Math.round((Number.isFinite(imbalance) ? imbalance * 100 : 0) + wallScore - spreadPenalty), -100, 100);
  return {
    status: "ok",
    score,
    imbalance: round(imbalance, 4),
    bidNotional: round(orderBook.bidNotional),
    askNotional: round(orderBook.askNotional),
    spreadPercent: round(orderBook.spreadPercent, 4),
    largestBidWallDistancePercent: round(orderBook.largestBidWall?.distancePercent, 4),
    largestAskWallDistancePercent: round(orderBook.largestAskWall?.distancePercent, 4)
  };
}

function summarizeAggressiveTrades(trades = null) {
  if (!Array.isArray(trades) || !trades.length) {
    return {
      status: "unavailable",
      score: 0,
      buyQuoteVolume: null,
      sellQuoteVolume: null,
      imbalance: null,
      buyTradeCount: 0,
      sellTradeCount: 0
    };
  }

  let buyQuoteVolume = 0;
  let sellQuoteVolume = 0;
  let buyTradeCount = 0;
  let sellTradeCount = 0;
  for (const trade of trades) {
    if (trade.side === "buy") {
      buyQuoteVolume += Number(trade.quoteQuantity || 0);
      buyTradeCount += 1;
    } else {
      sellQuoteVolume += Number(trade.quoteQuantity || 0);
      sellTradeCount += 1;
    }
  }
  const total = buyQuoteVolume + sellQuoteVolume;
  const imbalance = total ? (buyQuoteVolume - sellQuoteVolume) / total : 0;
  return {
    status: "ok",
    score: clamp(Math.round(imbalance * 100), -100, 100),
    buyQuoteVolume: round(buyQuoteVolume),
    sellQuoteVolume: round(sellQuoteVolume),
    totalQuoteVolume: round(total),
    imbalance: round(imbalance, 4),
    buyTradeCount,
    sellTradeCount
  };
}

function summarizeRelativeStrength(market = {}, regime = null) {
  const marketChange = Number(market.priceChangePercent);
  const anchor = Number(regime?.anchorChangePercent);
  if (!Number.isFinite(marketChange) || !Number.isFinite(anchor)) {
    return {
      status: "unavailable",
      score: 0,
      marketChangePercent: round(marketChange, 4),
      anchorChangePercent: round(anchor, 4),
      relativeChangePercent: null
    };
  }

  const relativeChangePercent = marketChange - anchor;
  return {
    status: "ok",
    score: clamp(Math.round(relativeChangePercent * 8), -100, 100),
    marketChangePercent: round(marketChange, 4),
    anchorChangePercent: round(anchor, 4),
    relativeChangePercent: round(relativeChangePercent, 4)
  };
}

function summarizeDerivatives(market = {}) {
  const fusion = market.fusion;
  if (fusion?.longScore !== undefined || fusion?.shortScore !== undefined) {
    return {
      status: fusion.status || "ok",
      score: clamp(Math.round((Number(fusion.longScore || 0) - Number(fusion.shortScore || 0)) * 3), -100, 100),
      longScore: fusion.longScore,
      shortScore: fusion.shortScore,
      fundingRate: fusion.derivatives?.fundingRate,
      openInterestChangePercent: fusion.derivatives?.openInterestChangePercent,
      longShortAccountRatio: fusion.derivatives?.longShortAccountRatio
    };
  }

  return {
    status: market.marketType === "futures" ? "unavailable" : "not_required",
    score: 0,
    longScore: null,
    shortScore: null
  };
}

function computeDataQuality({ microstructure, orderBook, flow, regime, market }) {
  let available = 0;
  let expected = 4;
  if (orderBook.status === "ok") available += 1;
  if (flow.status === "ok") available += 1;
  if (regime?.status === "ok") available += 1;
  if (Number.isFinite(Number(market.priceChangePercent))) available += 1;

  if (market.marketType === "futures") {
    expected += 1;
    if (market.fusion?.status === "ok" || market.fusion?.status === "partial") available += 1;
  }

  const ratio = available / expected;
  return {
    status: microstructure?.status === "unavailable" && ratio < 0.5 ? "unavailable" : ratio >= 0.75 ? "ok" : "partial",
    available,
    expected,
    weight: clamp(0.65 + ratio * 0.35, 0.65, 1),
    errors: (microstructure?.errors || []).slice(0, 3)
  };
}

function compactMicrostructure(microstructure = null) {
  if (!microstructure) return null;
  return {
    status: microstructure.status,
    orderBook: summarizeOrderBook(microstructure.orderBook),
    aggressiveFlow: summarizeAggressiveTrades(microstructure.aggressiveTrades),
    errors: (microstructure.errors || []).slice(0, 3)
  };
}

function buildEvidence({ edgeScore, orderBook, flow, regime, relative, derivatives }) {
  const evidence = [];
  if (flow.status === "ok") {
    if (flow.score >= 20) evidence.push("主动买入成交占优");
    if (flow.score <= -20) evidence.push("主动卖出成交占优");
  }
  if (orderBook.status === "ok") {
    if (orderBook.score >= 20) evidence.push("盘口买盘厚度占优");
    if (orderBook.score <= -20) evidence.push("盘口卖盘厚度占优");
  }
  if (regime?.bias === "risk_on") evidence.push("全市场风险偏好偏多");
  if (regime?.bias === "risk_off") evidence.push("全市场风险偏好偏空");
  if (relative.status === "ok") {
    if (relative.score >= 15) evidence.push("本币强于BTC/ETH锚");
    if (relative.score <= -15) evidence.push("本币弱于BTC/ETH锚");
  }
  if (derivatives.status === "ok" || derivatives.status === "partial") {
    if (derivatives.score >= 15) evidence.push("合约持仓/资金费率偏多确认");
    if (derivatives.score <= -15) evidence.push("合约持仓/资金费率偏空确认");
  }
  if (!evidence.length) evidence.push(edgeScore > 0 ? "方向略偏多但证据不足" : edgeScore < 0 ? "方向略偏空但证据不足" : "实时方向证据中性");
  return evidence.slice(0, 6);
}

function wallPressureScore(orderBook = {}) {
  const bidWall = Number(orderBook.largestBidWall?.notional || 0);
  const askWall = Number(orderBook.largestAskWall?.notional || 0);
  const total = bidWall + askWall;
  if (!total) return 0;
  return ((bidWall - askWall) / total) * 25;
}

function probabilityFromEdge(edgeScore) {
  const probability = 1 / (1 + Math.exp(-Number(edgeScore || 0) / 24));
  return round(probability, 4);
}

function directionSide(direction) {
  if (LONG_DIRECTIONS.has(direction)) return "long";
  if (SHORT_DIRECTIONS.has(direction)) return "short";
  return "neutral";
}

function findMarket(markets, symbol) {
  return markets.find((item) => item.symbol === symbol) || null;
}

function meanFinite(values) {
  const nums = values.filter(Number.isFinite);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null;
}
