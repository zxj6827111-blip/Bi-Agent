# Binance Futures 急拉雷达 NAS 部署与验收

## 1. 运行边界

- 急拉发现：Binance USD-M Futures WebSocket 连续流，目标延迟 1-2 秒。
- 30 秒刷新：只刷新候选池、健康状态和 `latest.json`，不是 30 秒轮询行情。
- 交易模式：严格 `paper-only`，不读取 Binance 交易密钥、不自动下单。
- 跨所数据：Gate 和 Bitget 只确认同向变化，任何成交价、止损价和收益计算仍以 Binance Futures 盘口为准。
- 顶部处理：系统不预测精确顶部，使用硬止损、止盈、峰值回撤跟踪和动量反转退出。

## 2. 合并环境变量

升级已有 NAS 时，不要用仓库模板覆盖正在运行的 `.env`。保留现有密钥和正式监控参数，只从 `.env.example` 合并以下新配置组：

```dotenv
BINANCE_REQUEST_RETRY_COUNT=1
BINANCE_REQUEST_RETRY_BASE_DELAY_MS=250
BINANCE_METADATA_CACHE_MS=21600000
BINANCE_METADATA_STALE_MS=86400000

PUMP_RADAR_DURATION_SECONDS=0
PUMP_RADAR_SNAPSHOT_SECONDS=30
PUMP_RADAR_CANDIDATE_REFRESH_SECONDS=30
BINANCE_FUTURES_STREAM_URL=wss://fstream.binance.com
PUMP_RADAR_STREAM_STALE_SECONDS=8
PUMP_RADAR_MAX_UNIVERSE_SYMBOLS=1000
PUMP_RADAR_MIN_QUOTE_VOLUME=5000000
PUMP_RADAR_MIN_DISCOVERY_BOOK_NOTIONAL=500
PUMP_RADAR_MAX_CANDIDATES=12
PUMP_RADAR_MOVE_10S_PERCENT=1.2
PUMP_RADAR_MOVE_30S_PERCENT=2.0
PUMP_RADAR_MOVE_60S_PERCENT=3.0
PUMP_RADAR_WATCH_MIN_SECONDS=3
PUMP_RADAR_WATCH_MAX_SECONDS=20
PUMP_RADAR_MIN_CONFIRM_SCORE=70
PUMP_RADAR_MAX_SPREAD_PERCENT=0.25
PUMP_RADAR_MIN_TOP_BOOK_NOTIONAL=15000
PUMP_RADAR_MIN_TRADE_QUOTE=10000
PUMP_RADAR_MIN_BUY_RATIO=0.58
PUMP_RADAR_MIN_DEPTH_IMBALANCE=-0.2
PUMP_RADAR_MAX_ENTRY_CHASE_PERCENT=1.5
PUMP_RADAR_COOLDOWN_SECONDS=600

PUMP_RADAR_CROSS_VENUE_ENABLED=true
PUMP_RADAR_CROSS_VENUE_STRICT=false
PUMP_RADAR_CROSS_VENUE_REQUIRED=1
PUMP_RADAR_CROSS_VENUE_MIN_MOVE_PERCENT=0.03

PUMP_RADAR_PAPER_NOTIONAL=1000
PUMP_RADAR_MAX_OPEN_POSITIONS=3
PUMP_RADAR_INITIAL_STOP_PERCENT=0.7
PUMP_RADAR_TAKE_PROFIT_PERCENT=2.5
PUMP_RADAR_TRAILING_ACTIVATION_PERCENT=0.8
PUMP_RADAR_TRAILING_DISTANCE_PERCENT=0.45
PUMP_RADAR_MOMENTUM_EXIT_PERCENT=-0.25
PUMP_RADAR_MAX_HOLD_SECONDS=300
PUMP_RADAR_NOTIFY_EVENTS=confirmed,entry,exit,source_degraded,source_recovered
```

`PUMP_RADAR_CROSS_VENUE_STRICT=false` 表示跨所不可用时只降低证据强度，不会把 Gate/Bitget 当作 Binance 的备用成交源。完成足够 paper 样本前不要改为自动实盘。

## 3. 构建和启动

```bash
cd /vol1/docker/bi-agent
docker compose up -d --build bi-agent-radar bi-agent-server
docker compose ps
docker compose logs --tail=200 bi-agent-radar
```

正式趋势监控 `bi-agent-monitor` 与急拉雷达 `bi-agent-radar` 是两个独立服务。雷达异常不会要求停止正式监控。

## 4. 验收

```bash
docker compose ps bi-agent-radar
docker compose logs --tail=200 bi-agent-radar
cat data/pump-radar/runtime.json
curl -s http://127.0.0.1:4173/api/radar/status
```

验收条件：

1. 容器状态为 `healthy`，`runtime.json` 在 90 秒内更新。
2. `health.mainSource` 为 `healthy`。
3. `health.stream.market.connected` 和 `health.stream.detail.connected` 均为 `true`。
4. `universe.totalPerpetualUsdt` 大于 0，能够覆盖 Binance 仅合约标的。
5. `mode` 为 `binance_futures_pump_radar_paper_only`。
6. 事件文件按日分片，`latest.json` 不持续膨胀。
7. 断开 WebSocket 后会记录 `source_degraded` 并阻止新纸面仓；恢复后记录 `source_recovered`。

没有触发交易不代表服务失效。应先看流连接、消息计数、候选池和拒绝原因，再判断是否只是市场未达到阈值。

## 5. Binance 超时说明

日志中的：

```text
Binance API request failed ... data-api.binance.vision ... timeout after 8000ms
```

表示 NAS 到该公开 REST 端点在超时时间内未完成连接或响应，常见原因是跨境链路抖动、DNS/代理路径或大响应（例如 `exchangeInfo`），不是策略逻辑错误。改造后会：

- 对瞬时网络错误做一次指数退避重试；
- 缓存 `exchangeInfo`，刷新失败时在有效期内使用旧元数据；
- 在错误中记录 path、attempt 和 elapsed；
- 急拉热路径使用 Futures WebSocket，不等待 Spot 全市场 REST 扫描。
- Futures REST 返回 451 时，从 Binance 全市场 `bookTicker` 动态建立 USDT 合约池，并按币种节流处理；主行情仍然来自 Binance。

如果 `api.binance.com`、`api1` 至 `api4` 在当前网络返回 HTTP 451，不要把它们加入伪备用列表。只有实测可访问且数据属于同一 Binance 市场的端点才可作为 REST fallback。

Gate、Bitget 或 MEXC 的公开行情可以辅助判断方向，但价格、合约规则、成交量口径和流动性都可能与 Binance 不同，不能保证逐笔一致，也不能作为 Binance 纸面成交价。

## 6. 独立回滚

```bash
docker compose stop bi-agent-radar
docker compose rm -f bi-agent-radar
```

该操作不会停止 `bi-agent-monitor` 或删除 `data/pump-radar/`。恢复时重新执行：

```bash
docker compose up -d --build bi-agent-radar
```
