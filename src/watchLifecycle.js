const TRADE_DIRECTIONS = new Set(["spot_buy", "spot_sell", "long", "short"]);
const DEFAULT_ENTRY_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_REVERSE_COOLDOWN_MS = 2 * 60 * 1000;
const EXIT_SIGNAL_MIN_SCORE = 68;

export function applyWatchLifecycle({
  current,
  position = null,
  now = Date.now(),
  entryTimeoutMs = DEFAULT_ENTRY_TIMEOUT_MS,
  reverseCooldownMs = DEFAULT_REVERSE_COOLDOWN_MS
}) {
  const rawAlert = current.alert || {};
  const price = Number(current.price);
  const events = [];

  if (isActivePosition(position)) {
    let nextPosition = maybeMarkEntry(position, price, now);
    if (nextPosition !== position) {
      events.push(makeEvent("entry", nextPosition, price, "价格进入入场区间，进入虚拟持仓观察。", now));
    }

    const close = evaluateClose(nextPosition, price, now);
    if (close) {
      const closed = {
        ...nextPosition,
        status: "closed",
        closeReason: close.reason,
        closeLabel: close.label,
        closePrice: price,
        closedAt: new Date(now).toISOString(),
        cooldownUntil: now + reverseCooldownMs
      };
      events.push(makeEvent("close", closed, price, close.message, now));
      return {
        current: withLifecycleAlert(current, closeAlert(closed, rawAlert), rawAlert, closed),
        position: closed,
        events
      };
    }

    const reverseExit = findReverseExitSignal(nextPosition, current);
    if (reverseExit) {
      const waiting = nextPosition.status === "waiting_entry";
      const closed = {
        ...nextPosition,
        status: "closed",
        closeReason: waiting ? "reverse_before_entry" : "reverse_signal",
        closeLabel: waiting ? "反向取消" : "反向平仓观察",
        closePrice: price,
        closedAt: new Date(now).toISOString(),
        cooldownUntil: now + reverseCooldownMs,
        reverseSignal: compactSignal(reverseExit)
      };
      events.push(makeEvent(
        "close",
        closed,
        price,
        `${positionLabel(nextPosition.direction)}出现${positionLabel(reverseExit.direction)}反向风险，先结束本轮观察。`,
        now
      ));
      return {
        current: withLifecycleAlert(current, closeAlert(closed, rawAlert), rawAlert, closed),
        position: closed,
        events
      };
    }

    if (isTradeAlert(rawAlert) && isOppositeDirection(nextPosition.direction, rawAlert.direction)) {
      events.push(makeEvent(
        "suppress_reverse",
        nextPosition,
        price,
        `已有${positionLabel(nextPosition.direction)}提醒未平仓，暂不切换到${positionLabel(rawAlert.direction)}。`,
        now
      ));
    }

    return {
      current: withLifecycleAlert(current, holdAlert(nextPosition, rawAlert), rawAlert, nextPosition),
      position: nextPosition,
      events
    };
  }

  if (position?.status === "closed" && now < Number(position.cooldownUntil || 0)) {
    return {
      current: withLifecycleAlert(current, cooldownAlert(position, rawAlert), rawAlert, position),
      position,
      events
    };
  }

  if (!isTradeAlert(rawAlert)) {
    return { current: { ...current, rawAlert, position: null }, position: null, events };
  }

  const nextPosition = createPosition({ current, alert: rawAlert, now, entryTimeoutMs });
  events.push(makeEvent("open_signal", nextPosition, price, `首次出现${positionLabel(nextPosition.direction)}提醒。`, now));
  return {
    current: withLifecycleAlert(current, { ...rawAlert, lifecycleStatus: "new_signal" }, rawAlert, nextPosition),
    position: nextPosition,
    events
  };
}

export function isTradeAlert(alert = {}) {
  return TRADE_DIRECTIONS.has(alert.direction);
}

export function lifecycleEventsToAlerts(current, lifecycleEvents = []) {
  return lifecycleEvents
    .filter((event) => ["open_signal", "entry", "close"].includes(event.type))
    .map((event) => ({
      id: event.id,
      time: event.time,
      symbol: event.symbol,
      price: event.price,
      action: event.action,
      actionHint: current.alert?.actionHint || "",
      direction: event.type === "close" ? "wait" : event.direction,
      positionDirection: event.direction,
      score: event.score || 0,
      entryRange: current.position?.entryRange || current.alert?.entryRange || null,
      stopLoss: current.position?.stopLoss || current.alert?.stopLoss || null,
      takeProfit: current.position?.takeProfit || current.alert?.takeProfit || null,
      riskLevel: current.alert?.riskLevel || "-",
      lifecycleType: event.type,
      message: event.message
    }));
}

function createPosition({ current, alert, now, entryTimeoutMs }) {
  const price = Number(current.price);
  const touchedEntry = priceInEntryRange(price, alert.entryRange);
  const signaledAt = new Date(now).toISOString();
  return {
    id: `${current.symbol}:${alert.direction}:${signaledAt}`,
    symbol: current.symbol,
    marketType: current.marketType || "spot",
    direction: alert.direction,
    action: alert.action,
    status: touchedEntry ? "open" : "waiting_entry",
    signaledAt,
    entryTouchedAt: touchedEntry ? signaledAt : null,
    entryPrice: touchedEntry ? price : null,
    entryRange: alert.entryRange,
    stopLoss: alert.stopLoss,
    takeProfit: alert.takeProfit,
    score: alert.score,
    timeframe: alert.timeframe,
    riskReward: alert.riskReward,
    expiresAt: now + entryTimeoutMs
  };
}

function maybeMarkEntry(position, price, now) {
  if (position.status !== "waiting_entry") return position;
  if (!priceInEntryRange(price, position.entryRange)) return position;
  return {
    ...position,
    status: "open",
    entryTouchedAt: new Date(now).toISOString(),
    entryPrice: price
  };
}

function evaluateClose(position, price, now) {
  if (!Number.isFinite(price)) return null;

  if (position.status === "waiting_entry") {
    if (Number.isFinite(Number(position.expiresAt)) && now >= Number(position.expiresAt)) {
      return {
        reason: "expired",
        label: "过期取消",
        message: "价格长期未进入入场区间，本次提醒过期。"
      };
    }
    if (isStopHit(position.direction, price, position.stopLoss)) {
      return {
        reason: "invalid_before_entry",
        label: "入场前失效",
        message: "尚未入场前已触及止损/失效价，本次提醒取消。"
      };
    }
    return null;
  }

  if (isTakeProfitHit(position.direction, price, position.takeProfit?.tp2)) {
    return { reason: "tp2", label: "TP2 平仓", message: "价格触达 TP2，虚拟持仓进入平仓观察。" };
  }
  if (isTakeProfitHit(position.direction, price, position.takeProfit?.tp1)) {
    return { reason: "tp1", label: "TP1 平仓", message: "价格触达 TP1，虚拟持仓进入平仓观察。" };
  }
  if (isStopHit(position.direction, price, position.stopLoss)) {
    return { reason: "stop", label: "止损平仓", message: "价格触达止损，虚拟持仓进入平仓观察。" };
  }
  return null;
}

function findReverseExitSignal(position, current) {
  const candidates = Array.isArray(current.exitSignals) ? current.exitSignals : [];
  const minScore = Math.max(EXIT_SIGNAL_MIN_SCORE, Number(position.score || 0) - 5);
  return candidates
    .filter((signal) => isTradeAlert(signal))
    .filter((signal) => isOppositeDirection(position.direction, signal.direction))
    .filter((signal) => Number(signal.score || 0) >= minScore)
    .sort((a, b) => {
      const scoreDiff = Number(b.score || 0) - Number(a.score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return timeframeWeight(b.timeframe) - timeframeWeight(a.timeframe);
    })[0] || null;
}

function compactSignal(signal) {
  if (!signal) return null;
  return {
    direction: signal.direction,
    timeframe: signal.timeframe,
    score: signal.score,
    entryRange: signal.entryRange,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    riskReward: signal.riskReward
  };
}

function withLifecycleAlert(current, alert, rawAlert, position) {
  return {
    ...current,
    rawAlert,
    position,
    alert
  };
}

function holdAlert(position, rawAlert) {
  const waiting = position.status === "waiting_entry";
  const label = waiting ? "等待入场" : "等待平仓";
  return {
    ...rawAlert,
    action: `${positionLabel(position.direction)}${label}`,
    actionHint: waiting
      ? "已有开仓提醒在等待入场，未过期或失效前不切换反向信号。"
      : "已有虚拟持仓观察，需先触达 TP 或止损后才允许反向提醒。",
    direction: position.direction,
    label: `${positionLabel(position.direction)}${label}`,
    lifecycleStatus: waiting ? "waiting_entry" : "holding",
    entryRange: position.entryRange,
    stopLoss: position.stopLoss,
    takeProfit: position.takeProfit,
    score: position.score,
    timeframe: position.timeframe,
    riskReward: position.riskReward,
    reasons: [
      `当前仍处于${positionLabel(position.direction)}${label}流程。`,
      "反向信号会被暂时忽略，避免同一币种来回跳多空。"
    ],
    riskNotes: rawAlert.riskNotes || []
  };
}

function closeAlert(position, rawAlert) {
  return {
    ...rawAlert,
    action: `${positionLabel(position.direction)}${position.closeLabel}`,
    actionHint: "本次虚拟持仓观察已结束，下一个刷新周期才允许重新选择方向。",
    direction: "wait",
    label: `${positionLabel(position.direction)}${position.closeLabel}`,
    lifecycleStatus: "closed",
    score: 0,
    entryRange: position.entryRange,
    stopLoss: position.stopLoss,
    takeProfit: position.takeProfit,
    reasons: [position.closeLabel],
    riskNotes: ["这是提醒生命周期的平仓状态，不代表系统已经实际下单或平仓。"]
  };
}

function cooldownAlert(position, rawAlert) {
  return {
    ...rawAlert,
    action: "平仓后冷却",
    actionHint: "刚结束上一轮虚拟持仓观察，短暂冷却后再允许新方向提醒。",
    direction: "wait",
    label: "平仓后冷却",
    lifecycleStatus: "cooldown",
    score: 0,
    entryRange: null,
    stopLoss: null,
    takeProfit: null,
    riskReward: null,
    reasons: ["平仓后冷却中，避免刚平仓立即反向开仓。"],
    riskNotes: rawAlert.riskNotes || []
  };
}

function makeEvent(type, position, price, message, now) {
  const time = new Date(now).toISOString();
  return {
    type,
    id: `${position.symbol}:${type}:${position.direction}:${position.signaledAt || ""}:${position.closedAt || ""}`,
    time,
    symbol: position.symbol,
    price,
    action: eventAction(type, position),
    direction: position.direction,
    score: position.score || 0,
    message
  };
}

function eventAction(type, position) {
  if (type === "entry") return `${positionLabel(position.direction)}入场`;
  if (type === "close") return `${positionLabel(position.direction)}${position.closeLabel}`;
  if (type === "suppress_reverse") return "反向信号已忽略";
  return `${positionLabel(position.direction)}提醒`;
}

function isActivePosition(position) {
  return position && ["waiting_entry", "open"].includes(position.status);
}

function isOppositeDirection(currentDirection, nextDirection) {
  return directionSide(currentDirection) !== directionSide(nextDirection);
}

function directionSide(direction) {
  if (direction === "long" || direction === "spot_buy") return "long";
  if (direction === "short" || direction === "spot_sell") return "short";
  return "neutral";
}

function timeframeWeight(timeframe) {
  if (timeframe === "15m") return 3;
  if (timeframe === "5m") return 2;
  if (timeframe === "1m") return 1;
  return 0;
}

function isShortLike(direction) {
  return direction === "short" || direction === "spot_sell";
}

function isTakeProfitHit(direction, price, target) {
  const value = Number(target);
  if (!Number.isFinite(value)) return false;
  return isShortLike(direction) ? price <= value : price >= value;
}

function isStopHit(direction, price, stop) {
  const value = Number(stop);
  if (!Number.isFinite(value)) return false;
  return isShortLike(direction) ? price >= value : price <= value;
}

function priceInEntryRange(price, range) {
  if (!Number.isFinite(price) || !Array.isArray(range) || range.length !== 2) return false;
  const [low, high] = range.map(Number).sort((a, b) => a - b);
  return price >= low && price <= high;
}

function positionLabel(direction) {
  if (direction === "long") return "合约开多";
  if (direction === "short") return "合约开空";
  if (direction === "spot_buy") return "现货买入";
  if (direction === "spot_sell") return "现货卖出";
  return "信号";
}
