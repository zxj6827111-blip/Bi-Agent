export function buildFormalSafetyFailures(candidate, options = {}) {
  const failures = [];
  const epsilon = Number(options.epsilon ?? 1e-8);
  const side = candidate?.side;
  const change24h = Number(candidate?.priceChangePercent24h);
  const atrPercent = Number(candidate?.atrPercent);
  const spreadPercent = Number(candidate?.spreadPercent);
  const targetPercent = Number(candidate?.targetPercent);
  const stopPercent = Number(candidate?.stopPercent);
  const roundTripCostPercent = Math.max(0, Number(candidate?.roundTripCostPercent ?? options.roundTripCostPercent ?? 0));
  const maxChase24hPercent = numberOrInfinity(options.maxChase24hPercent);
  const maxLongChase24hPercent = numberOrFallback(options.maxLongChase24hPercent, maxChase24hPercent);
  const maxShortChase24hPercent = numberOrFallback(options.maxShortChase24hPercent, maxChase24hPercent);
  const maxAtrPercent = numberOrInfinity(options.maxAtrPercent);
  const maxSpreadPercent = numberOrInfinity(options.maxSpreadPercent);
  const minNetTargetPercent = Number(options.minNetTargetPercent);
  const minRewardRisk = Number(options.minRewardRisk);
  const minNetRewardRisk = Number(options.minNetRewardRisk);
  const requireDerivativesHealthy = Boolean(options.requireDerivativesHealthy);

  if (Number.isFinite(change24h)) {
    if (side === "long" && Number.isFinite(maxLongChase24hPercent) && change24h >= maxLongChase24hPercent) {
      failures.push("chase24h");
    }
    if (side === "short" && Number.isFinite(maxShortChase24hPercent) && change24h <= -maxShortChase24hPercent) {
      failures.push("chase24h");
    }
  }

  if (Number.isFinite(atrPercent) && Number.isFinite(maxAtrPercent) && atrPercent > maxAtrPercent) {
    failures.push("volatility");
  }

  if (Number.isFinite(spreadPercent) && Number.isFinite(maxSpreadPercent) && spreadPercent > maxSpreadPercent) {
    failures.push("spread");
  }

  if (Number.isFinite(targetPercent) && Number.isFinite(minNetTargetPercent)) {
    const netTargetPercent = targetPercent - roundTripCostPercent;
    if (netTargetPercent + epsilon < minNetTargetPercent) failures.push("net_target");
  }

  if (Number.isFinite(targetPercent) && Number.isFinite(stopPercent) && stopPercent > 0 && Number.isFinite(minRewardRisk)) {
    const rewardRisk = targetPercent / stopPercent;
    if (rewardRisk + epsilon < minRewardRisk) failures.push("reward_risk");
  }

  if (Number.isFinite(targetPercent) && Number.isFinite(stopPercent) && stopPercent > 0 && Number.isFinite(minNetRewardRisk)) {
    const netTarget = targetPercent - roundTripCostPercent;
    const netLoss = stopPercent + roundTripCostPercent;
    const netRatio = netTarget > 0 && netLoss > 0 ? netTarget / netLoss : 0;
    if (netRatio + epsilon < minNetRewardRisk) failures.push("net_reward_risk");
  }

  if (requireDerivativesHealthy && candidate?.derivativesStatus !== "ok") {
    failures.push("derivatives_unavailable");
  }

  // Phase 2.1: ADX < 15 + volume < 1.0 时增加 low_trend_strength 失败
  // candidate.adx 是数值（snapshot.indicators.adx），非对象
  const adxValue = candidate?.adx == null ? null : Number(candidate.adx);
  const volumeRatio = Number(candidate?.volumeRatio);
  if (Number.isFinite(adxValue) && adxValue < 15 && Number.isFinite(volumeRatio) && volumeRatio < 1.0) {
    failures.push("low_trend_strength");
  }

  return failures;
}

export function allowsRiskOffShortEntry(candidate, { executionMinEdge = 0 } = {}) {
  return candidate?.side === "short"
    && candidate?.marketRegime?.bias === "risk_off"
    && ["down", "weakening"].includes(candidate?.trend)
    && Boolean(candidate?.technicalAligned)
    && Number(candidate?.edgeAligned || 0) >= Number(executionMinEdge || 0);
}

export function updateSignalConfirmations(confirmations, candidates, {
  scanCount,
  requiredScans = 1,
  staleScans = 3,
  consecutiveOnly = true,
  nowIso = new Date().toISOString()
} = {}) {
  const required = Math.max(1, Number(requiredScans) || 1);
  const stale = Math.max(1, Number(staleScans) || 1);
  const currentScan = Number(scanCount) || 0;
  let next = { ...(confirmations || {}) };
  const confirmed = [];

  for (const candidate of candidates || []) {
    const key = confirmationKey(candidate);
    const previous = next[key];
    const consecutive = previous?.lastSeenScan === currentScan - 1;
    const withinRecentWindow = Number(previous?.lastSeenScan) >= currentScan - stale;
    const canContinue = consecutiveOnly ? consecutive : withinRecentWindow;
    const count = canContinue ? previous.count + 1 : 1;
    const confirmation = {
      key,
      count,
      required,
      consecutiveOnly: Boolean(consecutiveOnly),
      ready: count >= required,
      firstSeenAt: canContinue ? previous.firstSeenAt : nowIso,
      lastSeenAt: nowIso,
      lastSeenScan: currentScan
    };
    next[key] = {
      symbol: candidate.symbol,
      side: candidate.side,
      ...confirmation
    };
    confirmed.push({ ...candidate, confirmation });
  }

  const earliestAllowedScan = currentScan - stale;
  next = Object.fromEntries(
    Object.entries(next).filter(([, item]) => Number(item.lastSeenScan) >= earliestAllowedScan)
  );

  const readyCandidates = confirmed.filter((candidate) => candidate.confirmation.ready);
  const pendingCandidates = confirmed.filter((candidate) => !candidate.confirmation.ready);

  return {
    confirmations: next,
    candidates: confirmed,
    readyCandidates,
    pendingCandidates,
    diagnostics: {
      tracked: Object.keys(next).length,
      evaluated: confirmed.length,
      ready: readyCandidates.length,
      pending: pendingCandidates.length,
      requiredScans: required,
      staleScans: stale,
      consecutiveOnly: Boolean(consecutiveOnly)
    }
  };
}

export function confirmationKey(candidate) {
  return `${candidate?.symbol || "unknown"}:${candidate?.side || "unknown"}`;
}

function numberOrInfinity(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Infinity;
}

function numberOrFallback(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
