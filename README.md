# Bi-Agent 本地虚拟货币辅助交易系统

这是一个本地运行的行情扫描和辅助分析系统。它只使用币安公开行情数据，输出候选交易机会、入场区间、止盈止损和风险提示，不自动下单、不保存交易所密钥、不承诺收益。

## 功能

- 按需运行：打开页面后点击“开始扫描”，平时不开也没关系。
- 覆盖市场：Binance Spot USDT 现货交易对、Binance USD-M Futures 永续合约。
- 策略初筛：15m、1h、4h K 线，结合成交量、趋势、RSI、MACD、ATR、支撑压力。
- 点位建议：入场区间、止损、TP1/TP2、盈亏比、失效条件。
- AI 辅助：设置 `OPENAI_API_KEY` 后会对 Top 候选做结构化风险分析；未设置时使用本地规则分析。
- 本地复盘：每次扫描会话会保存到 `data/bi-agent.sqlite`。
- 成本复盘：复盘会同时统计毛收益和扣除手续费/滑点后的净收益、收益因子、回撤。
- 纸面交易：分时监控里的虚拟持仓会保存为 paper trade 账本，用于持续验证，不代表真实下单。

## 快速启动

```powershell
npm start
```

然后打开：

```text
http://localhost:4173
```

## 配置 `.env`

项目会自动读取根目录下的 `.env` 文件。使用中转站时，主要改这三项：

```env
OPENAI_API_KEY=你的中转站Key
OPENAI_MODEL=gpt-5.5
OPENAI_BASE_URL=https://你的中转站域名/v1
```

如果同名变量已经在 PowerShell 或系统环境变量里设置过，系统环境变量会优先于 `.env`。

未设置 `OPENAI_API_KEY` 时，系统仍可完整扫描行情，只是 AI 分析会降级为本地规则摘要。

如果你的中转站不是标准 `/v1/responses` 兼容地址，可以直接指定完整接口：

```powershell
$env:OPENAI_RESPONSES_URL="你的中转站完整 responses 接口地址"
```

如果你所在网络访问 Binance Futures API 返回 `451`，页面会继续展示现货扫描结果，并在顶部提示“部分市场接口不可用”。后续可以把 `BINANCE_FUTURES_BASE_URL` 改成你本地网络可访问的 Binance 合约 API 网关。

## 安全边界

- 不接入 Binance 私有 API。
- 不保存 API Secret。
- 不下单、不开仓、不平仓。
- 合约信号只做风险提示和分析参考，默认不推荐高杠杆。

## 验证

```powershell
npm test
```

测试覆盖指标计算、低流动性过滤、信号生成、成本复盘和监控生命周期。

## 指定币种回放

可以用最近一段历史 K 线对指定币种做纸面回放：

```powershell
npm run replay -- BTCUSDT ETHUSDT SOLUSDT BNBUSDT XRPUSDT
```

默认回放 60 天，按 15m 节奏逐步生成信号，再用之后的 K 线评估 4h/24h 结果。输出里的 `validation.status` 只有在样本数、净胜率、净期望和最大回撤都达标时才会是 `passed`。如果是 `insufficient_or_failed`，应视为当前规则没有通过验证，不建议按这些信号交易。
## Feishu notifications

Bi-Agent supports both Feishu custom bot webhooks and self-built application messages. Set these variables in `.env` or Docker Compose:

```env
FEISHU_ENABLED=true
FEISHU_MESSAGE_MODE=webhook
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/your-webhook
FEISHU_SECRET=
FEISHU_MARKET_SIGNAL_LEVELS=formal
FEISHU_LIFECYCLE_EVENTS=open_signal,entry,close
FEISHU_HIGH_PRECISION_ONLY=true
FEISHU_HIGH_PRECISION_SCORE=84
FEISHU_HIGH_PRECISION_VOLUME_RATIO=1.5
FEISHU_HIGH_PRECISION_VOLUME_SCORE=74
FEISHU_NOTIFY_COOLDOWN_MINUTES=60
```

Notification scope:

- Manual scan: pushes formal signals returned by "start scan".
- All-market watch: pushes formal short-term signals found in the market discovery loop.
- Symbol watch: pushes lifecycle alerts for `open_signal`, `entry`, and `close`, including TP/stop/reverse-close events.

For a self-built application, use the following configuration instead of `FEISHU_WEBHOOK_URL`:

```env
FEISHU_ENABLED=true
FEISHU_MESSAGE_MODE=app
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=your-app-secret
FEISHU_RECEIVE_ID_TYPE=open_id
FEISHU_RECEIVE_ID=ou_xxx
FEISHU_API_BASE_URL=https://open.feishu.cn/open-apis
```

`FEISHU_SECRET` is only for custom bot signature verification. In app mode, Bi-Agent gets a `tenant_access_token` from the application credentials, caches it until one minute before expiry, then sends the text message through the Feishu IM API.

App mode supports two delivery patterns:

- Direct message to a user: set `FEISHU_RECEIVE_ID_TYPE` to `open_id`, `user_id`, or `email`, and set `FEISHU_RECEIVE_ID` to that user identifier.
- Message to a group: set `FEISHU_RECEIVE_ID_TYPE=chat_id`, and set `FEISHU_RECEIVE_ID` to the target group `chat_id`.

If you want the app to appear as a direct conversation in Feishu instead of posting into a group, do not use `chat_id`. Use a user identifier such as `open_id` instead.

## Docker on NAS

Build and run:

```powershell
docker compose -f docker-compose.feishu.example.yml up -d --build
```

The service listens on `4173` and stores local SQLite data under `./data`.

## Scan scope

- The top manual scan scans liquid USDT spot markets and futures markets up to `TOP_SYMBOLS_PER_MARKET` per market type. Default is 24 spot + 24 futures.
- The watch panel scans only the symbols typed in the input box, up to 12 symbols.
- If "all-market auto discovery" is enabled in the watch panel, it scans eligible liquid markets up to `MARKET_WATCH_MAX_SYMBOLS`. Default is 80.
