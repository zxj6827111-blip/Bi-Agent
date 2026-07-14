export class PumpDetector {
  constructor(options = {}) {
    this.options = {
      minQuoteVolume: 5_000_000,
      move10sPercent: 1.2,
      move30sPercent: 2,
      move60sPercent: 3,
      watchMinSeconds: 3,
      watchMaxSeconds: 20,
      minConfirmScore: 70,
      maxSpreadPercent: 0.25,
      minTopBookNotional: 15_000,
      minTradeQuote: 10_000,
      minBuyRatio: 0.58,
      minDepthImbalance: -0.2,
      maxEntryChasePercent: 1.5,
      streamStaleSeconds: 8,
      crossVenueStrict: false,
      crossVenueRequired: 1,
      ...options
    };
  }

  evaluateDiscovery({ symbol, history, quoteVolume, now = Date.now() }) {
    const volume = Number(quoteVolume);
    if (!history || !Number.isFinite(volume) || volume < this.options.minQuoteVolume) {
      return { detected: false, reason: "insufficient_liquidity" };
    }

    const checks = [
      [10_000, this.options.move10sPercent],
      [30_000, this.options.move30sPercent],
      [60_000, this.options.move60sPercent]
    ];
    const movements = {};
    let trigger = null;
    for (const [windowMs, threshold] of checks) {
      const movePercent = history.changePercent(windowMs, now);
      movements[`${windowMs / 1_000}s`] = movePercent;
      if (movePercent != null && movePercent >= threshold) {
        const ratio = movePercent / Math.max(0.01, threshold);
        if (!trigger || ratio > trigger.ratio) trigger = { windowMs, threshold, movePercent, ratio };
      }
    }
    if (!trigger) return { detected: false, reason: "move_below_threshold", movements };

    const latest = history.latest();
    const base = history.priceAtOrBefore(now - trigger.windowMs);
    return {
      detected: true,
      symbol,
      detectedAt: now,
      triggerWindowMs: trigger.windowMs,
      triggerThresholdPercent: trigger.threshold,
      triggerMovePercent: trigger.movePercent,
      triggerPrice: latest?.price ?? null,
      basePrice: base?.price ?? null,
      quoteVolume: volume,
      movements,
      discoveryScore: clamp(35 + (trigger.ratio - 1) * 20, 35, 60)
    };
  }

  evaluateConfirmation({ discovery, currentPrice, book, depth, trades, crossVenue, now = Date.now() }) {
    const watchedMs = now - Number(discovery?.detectedAt || now);
    const pendingReasons = [];
    const failures = [];
    const evidence = [];
    let score = Number(discovery?.discoveryScore || 0);

    if (watchedMs < this.options.watchMinSeconds * 1_000) pendingReasons.push("minimum_watch_time");

    const price = Number(currentPrice);
    const triggerPrice = Number(discovery?.triggerPrice);
    const chasePercent = price > 0 && triggerPrice > 0 ? ((price - triggerPrice) / triggerPrice) * 100 : null;
    if (chasePercent == null) failures.push("missing_price");
    else if (chasePercent < -0.35) failures.push("move_reversed");
    else if (chasePercent > this.options.maxEntryChasePercent) failures.push("entry_too_late");
    else {
      score += clamp(chasePercent * 8, 0, 12);
      evidence.push(`post_trigger_move=${round(chasePercent)}%`);
    }

    const bookAgeMs = book?.eventTime ? now - Number(book.eventTime) : Number.POSITIVE_INFINITY;
    const bidPrice = Number(book?.bidPrice);
    const askPrice = Number(book?.askPrice);
    const mid = bidPrice > 0 && askPrice > 0 ? (bidPrice + askPrice) / 2 : null;
    const spreadPercent = mid ? ((askPrice - bidPrice) / mid) * 100 : null;
    const topBookNotional = bidPrice * Number(book?.bidQty || 0) + askPrice * Number(book?.askQty || 0);
    if (bookAgeMs > this.options.streamStaleSeconds * 1_000) pendingReasons.push("stale_book");
    else if (spreadPercent == null || spreadPercent > this.options.maxSpreadPercent) failures.push("spread_too_wide");
    else {
      score += 10;
      evidence.push(`spread=${round(spreadPercent)}%`);
    }
    if (!Number.isFinite(topBookNotional) || topBookNotional < this.options.minTopBookNotional) {
      failures.push("top_book_too_thin");
    } else {
      score += 5;
    }

    const tradeStats = trades || {};
    if (Number(tradeStats.totalQuote || 0) < this.options.minTradeQuote) pendingReasons.push("insufficient_trade_flow");
    else if (Number(tradeStats.buyRatio || 0) < this.options.minBuyRatio) failures.push("buy_flow_not_dominant");
    else {
      score += clamp((Number(tradeStats.buyRatio) - 0.5) * 50, 5, 15);
      evidence.push(`buy_ratio=${round(Number(tradeStats.buyRatio) * 100)}%`);
    }

    const depthImbalance = Number(depth?.imbalance);
    if (!Number.isFinite(depthImbalance)) pendingReasons.push("missing_depth");
    else if (depthImbalance < this.options.minDepthImbalance) failures.push("ask_depth_dominant");
    else {
      score += clamp((depthImbalance + 0.2) * 10, 0, 8);
      evidence.push(`depth_imbalance=${round(depthImbalance)}`);
    }

    const venueConfirmed = Number(crossVenue?.confirmedCount || 0);
    if (venueConfirmed > 0) {
      score += Math.min(8, venueConfirmed * 4);
      evidence.push(`cross_venue=${venueConfirmed}/${crossVenue.availableCount || 0}`);
    } else if (this.options.crossVenueStrict && Number(crossVenue?.availableCount || 0) > 0) {
      failures.push("cross_venue_not_confirmed");
    } else if (this.options.crossVenueStrict) {
      pendingReasons.push("cross_venue_unavailable");
    }

    score = clamp(score, 0, 100);
    const timedOut = watchedMs >= this.options.watchMaxSeconds * 1_000;
    const enoughCrossVenue = !this.options.crossVenueStrict || venueConfirmed >= this.options.crossVenueRequired;
    const confirmed = !pendingReasons.length && !failures.length && enoughCrossVenue && score >= this.options.minConfirmScore;

    if (confirmed) return buildResult("confirmed");
    if (failures.length || timedOut) return buildResult("rejected");
    return buildResult("pending");

    function buildResult(status) {
      return {
        status,
        score: round(score),
        watchedMs,
        chasePercent: roundOrNull(chasePercent),
        spreadPercent: roundOrNull(spreadPercent),
        topBookNotional: roundOrNull(topBookNotional),
        tradeStats,
        depthImbalance: roundOrNull(depthImbalance),
        pendingReasons,
        failures,
        evidence
      };
    }
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function round(value) {
  return Math.round(Number(value) * 10_000) / 10_000;
}

function roundOrNull(value) {
  return Number.isFinite(Number(value)) ? round(value) : null;
}
