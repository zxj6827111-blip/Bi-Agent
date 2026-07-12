import { clamp, percent, round } from "./utils.js";

const DERIVATIVE_UNAVAILABLE_PENALTY = 8;

export function withMarketSource(market, dataSourceMarketType) {
  return {
    ...market,
    requestedMarketType: market.marketType,
    actualMarketType: market.marketType,
    dataSourceMarketType,
    isFuturesProxy: false,
    marketNotice: null,
    proxyReason: null
  };
}

export function asFuturesProxy(spotMarket, catalog = {}) {
  const proxyReason = catalog.futuresError
    ? `Binance 合约接口不可用：${catalog.futuresError}`
    : "当前合约目录没有返回该币种，暂用现货行情代理合约方向。";

  return {
    ...spotMarket,
    requestedMarketType: "futures",
    actualMarketType: "spot",
    dataSourceMarketType: "spot",
    marketType: "futures",
    fundingRate: null,
    derivatives: {
      status: "unavailable",
      errors: [proxyReason]
    },
    isFuturesProxy: true,
    proxyReason,
    marketNotice: "合约接口受限，当前用现货 K 线代理判断多空方向；正式合约信号会自动降级为观察。"
  };
}

export function enrichMarketWithFusion({ market, catalog = {}, derivatives = null }) {
  const spotMarket = (catalog.spot || []).find((item) => item.symbol === market.symbol) || null;
  const futuresMarket = (catalog.futures || []).find((item) => item.symbol === market.symbol) || null;
  const normalizedDerivatives = market.marketType === "futures"
    ? normalizeDerivatives(derivatives || market.derivatives, market)
    : normalizeDerivatives(derivatives || futuresMarket?.derivatives, futuresMarket);
  const next = {
    ...market,
    spotContext: compactMarketContext(spotMarket),
    futuresContext: compactMarketContext(futuresMarket),
    derivatives: normalizedDerivatives,
    fundingRate: market.marketType === "futures"
      ? normalizedDerivatives.fundingRate ?? market.fundingRate ?? null
      : market.fundingRate ?? null
  };

  return {
    ...next,
    fusion: buildMarketFusion({
      market: next,
      spotMarket,
      futuresMarket,
      derivatives: normalizedDerivatives
    })
  };
}

export function buildMarketFusion({ market, spotMarket = null, futuresMarket = null, derivatives = null }) {
  const activeSpot = spotMarket || (market.marketType === "spot" ? market : null);
  const activeFutures = futuresMarket || (market.marketType === "futures" ? market : null);
  const spotImbalance = finiteNumber(activeSpot?.orderBookImbalance);
  const futuresImbalance = finiteNumber(activeFutures?.orderBookImbalance);
  const spread = finiteNumber(market.spreadPercent);
  const derivativesStatus = derivatives?.status || (market.marketType === "futures" ? "unavailable" : "not_required");
  const longScore = scoreFusionSide({
    direction: "long",
    market,
    spotMarket: activeSpot,
    futuresMarket: activeFutures,
    derivatives,
    spotImbalance,
    futuresImbalance,
    spread
  });
  const shortScore = scoreFusionSide({
    direction: "short",
    market,
    spotMarket: activeSpot,
    futuresMarket: activeFutures,
    derivatives,
    spotImbalance,
    futuresImbalance,
    spread
  });
  const bias = longScore - shortScore >= 8
    ? "bullish"
    : shortScore - longScore >= 8
      ? "bearish"
      : "neutral";

  return {
    status: market.isFuturesProxy ? "proxy" : derivativesStatus,
    bias,
    longScore: clamp(Math.round(longScore), -30, 30),
    shortScore: clamp(Math.round(shortScore), -30, 30),
    liquidity: {
      spotQuoteVolume: finiteNumber(activeSpot?.quoteVolume),
      futuresQuoteVolume: finiteNumber(activeFutures?.quoteVolume),
      spreadPercent: round(spread, 4),
      spotOrderBookImbalance: round(spotImbalance, 4),
      futuresOrderBookImbalance: round(futuresImbalance, 4),
      spotTopOfBookNotional: round(activeSpot?.topOfBookNotional),
      futuresTopOfBookNotional: round(activeFutures?.topOfBookNotional)
    },
    derivatives: {
      openInterest: round(derivatives?.openInterest),
      openInterestChangePercent: round(derivatives?.openInterestChangePercent, 3),
      fundingRate: derivatives?.fundingRate ?? market.fundingRate ?? null,
      fundingRatePercent: percent(derivatives?.fundingRate ?? market.fundingRate, 4),
      longShortAccountRatio: round(derivatives?.longShortAccountRatio, 4),
      topLongShortPositionRatio: round(derivatives?.topLongShortPositionRatio, 4),
      status: derivativesStatus,
      errors: (derivatives?.errors || []).slice(0, 3)
    },
    notes: buildFusionNotes({ market, derivatives, spotImbalance, futuresImbalance, spread, longScore, shortScore })
  };
}

export function fusionScoreAdjustment(fusion, direction, snapshot = {}) {
  if (!fusion) return 0;
  const bias = direction === "spot_buy" || direction === "long" ? "long" : "short";
  let adjustment = bias === "long" ? Number(fusion.longScore || 0) : Number(fusion.shortScore || 0);

  if (snapshot.marketType === "futures" && fusion.status === "unavailable") adjustment -= DERIVATIVE_UNAVAILABLE_PENALTY;
  if (snapshot.isFuturesProxy) adjustment -= 18;
  if (fusion.liquidity?.spreadPercent > 0.25) adjustment -= 6;
  return clamp(Math.round(adjustment), -25, 18);
}

export function fusionBlocksSignal(fusion, direction, snapshot = {}) {
  const blockers = [];
  const isLong = direction === "spot_buy" || direction === "long";
  const sideScore = isLong ? Number(fusion?.longScore || 0) : Number(fusion?.shortScore || 0);
  const oppositeScore = isLong ? Number(fusion?.shortScore || 0) : Number(fusion?.longScore || 0);

  if (snapshot.isFuturesProxy && snapshot.marketType === "futures") {
    blockers.push("合约接口不可用，当前只是现货代理方向，不允许作为正式合约提醒。");
  }

  if (snapshot.marketType === "futures" && fusion?.status === "unavailable") {
    blockers.push("缺少合约持仓量、资金费率和多空人数比，不能确认合约共振。");
  }

  if (oppositeScore - sideScore >= 12) {
    blockers.push(`现货/合约融合分歧过大：${isLong ? "空头" : "多头"}侧更强。`);
  }

  const ratio = Number(fusion?.derivatives?.longShortAccountRatio);
  const funding = Number(fusion?.derivatives?.fundingRate);
  if (isLong && ratio > 1.8 && funding > 0.0008) {
    blockers.push("多头人数和资金费率同时拥挤，追多容易被挤压。");
  }
  if (!isLong && ratio < 0.58 && funding < -0.0008) {
    blockers.push("空头人数和负资金费率同时拥挤，追空容易被反抽。");
  }

  return blockers;
}

export function compactFusionForAi(fusion = {}) {
  return {
    status: fusion.status,
    bias: fusion.bias,
    longScore: fusion.longScore,
    shortScore: fusion.shortScore,
    liquidity: fusion.liquidity,
    derivatives: fusion.derivatives,
    notes: (fusion.notes || []).slice(0, 4)
  };
}

function scoreFusionSide({ direction, market, spotMarket, futuresMarket, derivatives, spotImbalance, futuresImbalance, spread }) {
  let score = 0;
  const isLong = direction === "long";
  const priceChange = finiteNumber(market.priceChangePercent);
  const funding = finiteNumber(derivatives?.fundingRate ?? market.fundingRate);
  const oiChange = finiteNumber(derivatives?.openInterestChangePercent);
  const accountRatio = finiteNumber(derivatives?.longShortAccountRatio);
  const topPositionRatio = finiteNumber(derivatives?.topLongShortPositionRatio);
  const spotVolume = finiteNumber(spotMarket?.quoteVolume);
  const futuresVolume = finiteNumber(futuresMarket?.quoteVolume);

  if (spotVolume && futuresVolume) {
    const volumeRatio = futuresVolume / spotVolume;
    if (volumeRatio >= 0.35 && volumeRatio <= 3.5) score += 2;
    if (volumeRatio > 6) score -= 2;
  }

  if (spread > 0.25) score -= 4;
  if (isLong && spotImbalance > 0.12) score += 3;
  if (!isLong && spotImbalance < -0.12) score += 3;
  if (isLong && futuresImbalance > 0.1) score += 2;
  if (!isLong && futuresImbalance < -0.1) score += 2;
  if (isLong && spotImbalance < -0.2) score -= 4;
  if (!isLong && spotImbalance > 0.2) score -= 4;

  if (Number.isFinite(oiChange)) {
    if (isLong && priceChange > 0 && oiChange > 0.4) score += 5;
    if (!isLong && priceChange < 0 && oiChange > 0.4) score += 5;
    if (isLong && priceChange < 0 && oiChange > 0.8) score -= 5;
    if (!isLong && priceChange > 0 && oiChange > 0.8) score -= 5;
    if (Math.abs(oiChange) < 0.1) score -= 1;
  }

  if (Number.isFinite(funding)) {
    if (isLong && funding > 0.0008) score -= 5;
    if (isLong && funding < -0.0004) score += 2;
    if (!isLong && funding < -0.0008) score -= 5;
    if (!isLong && funding > 0.0004) score += 2;
  }

  if (Number.isFinite(accountRatio)) {
    if (isLong && accountRatio >= 1.05 && accountRatio <= 1.45) score += 3;
    if (!isLong && accountRatio <= 0.95 && accountRatio >= 0.68) score += 3;
    if (isLong && accountRatio > 1.8) score -= 6;
    if (!isLong && accountRatio < 0.58) score -= 6;
  }

  if (Number.isFinite(topPositionRatio)) {
    if (isLong && topPositionRatio > 1.8) score -= 3;
    if (!isLong && topPositionRatio < 0.55) score -= 3;
  }

  return score;
}

function buildFusionNotes({ market, derivatives, spotImbalance, futuresImbalance, spread, longScore, shortScore }) {
  const notes = [];
  if (market.isFuturesProxy) notes.push("合约数据不可用，当前为现货代理方向。");
  if (derivatives?.status === "partial") notes.push("合约衍生指标部分可用，缺失字段已降权。");
  if (derivatives?.status === "unavailable") notes.push("合约衍生指标不可用，正式合约信号需降级。");
  if (spread > 0.25) notes.push(`点差 ${round(spread, 3)}% 偏宽，滑点风险升高。`);
  if (spotImbalance > 0.12) notes.push("现货盘口买盘占优。");
  if (spotImbalance < -0.12) notes.push("现货盘口卖盘占优。");
  if (futuresImbalance > 0.1) notes.push("合约盘口买盘占优。");
  if (futuresImbalance < -0.1) notes.push("合约盘口卖盘占优。");
  if (longScore - shortScore >= 8) notes.push("现货/合约融合偏多。");
  if (shortScore - longScore >= 8) notes.push("现货/合约融合偏空。");
  return [...new Set(notes)].slice(0, 6);
}

function normalizeDerivatives(value = null, market = null) {
  if (!value) {
    return {
      status: market?.marketType === "futures" ? "unavailable" : "not_required",
      fundingRate: market?.fundingRate ?? null,
      errors: []
    };
  }
  return {
    status: value.status || "ok",
    openInterest: finiteNumber(value.openInterest),
    openInterestValue: finiteNumber(value.openInterestValue),
    openInterestChangePercent: finiteNumber(value.openInterestChangePercent),
    fundingRate: finiteNumber(value.fundingRate ?? market?.fundingRate),
    nextFundingTime: finiteNumber(value.nextFundingTime),
    longShortAccountRatio: finiteNumber(value.longShortAccountRatio),
    longAccountPercent: finiteNumber(value.longAccountPercent),
    shortAccountPercent: finiteNumber(value.shortAccountPercent),
    topLongShortPositionRatio: finiteNumber(value.topLongShortPositionRatio),
    errors: (value.errors || []).slice(0, 3)
  };
}

function compactMarketContext(market) {
  if (!market) return null;
  return {
    marketType: market.marketType,
    lastPrice: round(market.lastPrice),
    quoteVolume: round(market.quoteVolume),
    priceChangePercent: round(market.priceChangePercent, 3),
    spreadPercent: round(market.spreadPercent, 4),
    orderBookImbalance: round(market.orderBookImbalance, 4),
    topOfBookNotional: round(market.topOfBookNotional)
  };
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
