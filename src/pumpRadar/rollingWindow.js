export class RollingPriceWindow {
  constructor({ maxAgeMs = 90_000, maxPoints = 2_000 } = {}) {
    this.maxAgeMs = Math.max(1_000, Number(maxAgeMs) || 90_000);
    this.maxPoints = Math.max(10, Number(maxPoints) || 2_000);
    this.points = [];
  }

  add(timestamp, price, data = {}) {
    const ts = Number(timestamp);
    const numericPrice = Number(price);
    if (!Number.isFinite(ts) || !Number.isFinite(numericPrice) || numericPrice <= 0) return false;

    const last = this.points[this.points.length - 1];
    if (last && ts < last.ts) return false;
    if (last && ts === last.ts) {
      this.points[this.points.length - 1] = { ts, price: numericPrice, ...data };
    } else {
      this.points.push({ ts, price: numericPrice, ...data });
    }
    this.prune(ts);
    return true;
  }

  prune(now = Date.now()) {
    const cutoff = Number(now) - this.maxAgeMs;
    let removeCount = 0;
    while (removeCount < this.points.length && this.points[removeCount].ts < cutoff) removeCount += 1;
    if (removeCount) this.points.splice(0, removeCount);
    if (this.points.length > this.maxPoints) this.points.splice(0, this.points.length - this.maxPoints);
  }

  latest() {
    return this.points[this.points.length - 1] || null;
  }

  changePercent(windowMs, now = this.latest()?.ts) {
    const latest = this.latest();
    const duration = Number(windowMs);
    if (!latest || !Number.isFinite(Number(now)) || duration <= 0) return null;
    const cutoff = Number(now) - duration;
    const base = findPointAtOrBefore(this.points, cutoff);
    if (!base || Number(now) - base.ts < duration * 0.8 || base.price <= 0) return null;
    return ((latest.price - base.price) / base.price) * 100;
  }

  priceAtOrBefore(timestamp) {
    return findPointAtOrBefore(this.points, Number(timestamp));
  }

  snapshot(now = this.latest()?.ts) {
    return {
      latest: this.latest(),
      move5sPercent: this.changePercent(5_000, now),
      move10sPercent: this.changePercent(10_000, now),
      move30sPercent: this.changePercent(30_000, now),
      move60sPercent: this.changePercent(60_000, now),
      pointCount: this.points.length
    };
  }
}

export class RollingTradeWindow {
  constructor({ maxAgeMs = 30_000, maxPoints = 5_000 } = {}) {
    this.maxAgeMs = Math.max(1_000, Number(maxAgeMs) || 30_000);
    this.maxPoints = Math.max(10, Number(maxPoints) || 5_000);
    this.trades = [];
  }

  add(trade = {}) {
    const ts = Number(trade.eventTime ?? trade.time);
    const price = Number(trade.price);
    const quantity = Number(trade.quantity);
    const quote = Number(trade.quoteQuantity ?? price * quantity);
    if (![ts, price, quantity, quote].every(Number.isFinite) || price <= 0 || quantity <= 0) return false;
    const last = this.trades[this.trades.length - 1];
    if (last && ts < last.ts) return false;
    this.trades.push({
      ts,
      price,
      quantity,
      quote,
      buy: trade.buy ?? !trade.isBuyerMaker
    });
    this.prune(ts);
    return true;
  }

  prune(now = Date.now()) {
    const cutoff = Number(now) - this.maxAgeMs;
    let removeCount = 0;
    while (removeCount < this.trades.length && this.trades[removeCount].ts < cutoff) removeCount += 1;
    if (removeCount) this.trades.splice(0, removeCount);
    if (this.trades.length > this.maxPoints) this.trades.splice(0, this.trades.length - this.maxPoints);
  }

  stats(windowMs = 10_000, now = this.trades[this.trades.length - 1]?.ts ?? Date.now()) {
    const cutoff = Number(now) - Number(windowMs);
    let buyQuote = 0;
    let sellQuote = 0;
    let count = 0;
    for (let index = this.trades.length - 1; index >= 0; index -= 1) {
      const trade = this.trades[index];
      if (trade.ts < cutoff) break;
      if (trade.buy) buyQuote += trade.quote;
      else sellQuote += trade.quote;
      count += 1;
    }
    const totalQuote = buyQuote + sellQuote;
    return {
      count,
      buyQuote,
      sellQuote,
      totalQuote,
      buyRatio: totalQuote ? buyQuote / totalQuote : null
    };
  }
}

function findPointAtOrBefore(points, timestamp) {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (points[index].ts <= timestamp) return points[index];
  }
  return null;
}
