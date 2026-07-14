export function openPaperPosition({
  symbol,
  book,
  now = Date.now(),
  notional = 1_000,
  feeRate = 0.0005,
  slippagePercent = 0.05,
  initialStopPercent = 0.7,
  takeProfitPercent = 2.5,
  trailingActivationPercent = 0.8,
  trailingDistancePercent = 0.45,
  maxHoldSeconds = 300,
  signal = null
}) {
  const ask = Number(book?.askPrice);
  if (!Number.isFinite(ask) || ask <= 0) throw new Error(`No executable ask price for ${symbol}`);
  const fillPrice = applySlippage(ask, "buy", slippagePercent);
  const numericNotional = Number(notional);
  const quantity = numericNotional / fillPrice;
  const entryFee = numericNotional * Number(feeRate || 0);
  return {
    id: `${symbol}:${now}`,
    symbol,
    side: "long",
    status: "open",
    openedAt: new Date(now).toISOString(),
    openedAtMs: now,
    entryReferencePrice: ask,
    entryPrice: fillPrice,
    quantity,
    notional: numericNotional,
    entryFee,
    feeRate: Number(feeRate || 0),
    slippagePercent: Number(slippagePercent || 0),
    stopPrice: fillPrice * (1 - Number(initialStopPercent) / 100),
    takeProfitPrice: fillPrice * (1 + Number(takeProfitPercent) / 100),
    peakPrice: fillPrice,
    trailingStopPrice: null,
    trailingActivationPercent: Number(trailingActivationPercent),
    trailingDistancePercent: Number(trailingDistancePercent),
    maxHoldSeconds: Number(maxHoldSeconds),
    signal,
    lastPrice: fillPrice,
    momentumWeakCount: 0
  };
}

export function updatePaperPosition(position, { bidPrice, now = Date.now(), move5sPercent = null, buyRatio = null, momentumExitPercent = -0.25 } = {}) {
  const bid = Number(bidPrice);
  if (!Number.isFinite(bid) || bid <= 0) return { position, exit: null };
  const next = { ...position, lastPrice: bid };
  next.peakPrice = Math.max(Number(position.peakPrice || position.entryPrice), bid);
  const peakReturnPercent = percentChange(position.entryPrice, next.peakPrice);
  if (peakReturnPercent >= Number(position.trailingActivationPercent)) {
    next.trailingStopPrice = next.peakPrice * (1 - Number(position.trailingDistancePercent) / 100);
  }

  const momentumWeak = Number.isFinite(Number(move5sPercent))
    && Number(move5sPercent) <= Number(momentumExitPercent)
    && Number.isFinite(Number(buyRatio))
    && Number(buyRatio) < 0.5;
  next.momentumWeakCount = momentumWeak ? Number(position.momentumWeakCount || 0) + 1 : 0;

  let exit = null;
  if (bid <= Number(position.stopPrice)) exit = "hard_stop";
  else if (bid >= Number(position.takeProfitPrice)) exit = "take_profit";
  else if (next.trailingStopPrice && bid <= next.trailingStopPrice) exit = "trailing_stop";
  else if (next.momentumWeakCount >= 2) exit = "momentum_reversal";
  else if (now - Number(position.openedAtMs) >= Number(position.maxHoldSeconds) * 1_000) exit = "max_hold";
  return { position: next, exit };
}

export function closePaperPosition(position, { bidPrice, reason, now = Date.now() }) {
  const bid = Number(bidPrice);
  if (!Number.isFinite(bid) || bid <= 0) throw new Error(`No executable bid price for ${position.symbol}`);
  const exitPrice = applySlippage(bid, "sell", position.slippagePercent);
  const exitNotional = exitPrice * Number(position.quantity);
  const exitFee = exitNotional * Number(position.feeRate || 0);
  const grossPnl = (exitPrice - Number(position.entryPrice)) * Number(position.quantity);
  const netPnl = grossPnl - Number(position.entryFee || 0) - exitFee;
  return {
    ...position,
    status: "closed",
    closedAt: new Date(now).toISOString(),
    closedAtMs: now,
    exitReferencePrice: bid,
    exitPrice,
    exitFee,
    grossPnl,
    netPnl,
    grossReturnPercent: (grossPnl / Number(position.notional)) * 100,
    netReturnPercent: (netPnl / Number(position.notional)) * 100,
    holdSeconds: (now - Number(position.openedAtMs)) / 1_000,
    exitReason: reason
  };
}

function applySlippage(price, side, slippagePercent) {
  const fraction = Number(slippagePercent || 0) / 100;
  return Number(price) * (side === "buy" ? 1 + fraction : 1 - fraction);
}

function percentChange(from, to) {
  return ((Number(to) - Number(from)) / Number(from)) * 100;
}
