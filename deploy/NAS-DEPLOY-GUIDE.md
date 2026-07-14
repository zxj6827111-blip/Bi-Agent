# Bi-Agent 飞牛 NAS Docker 部署指南

## 一、概述

本指南将 Bi-Agent 纸面交易系统以 Docker 容器方式部署到飞牛 NAS，实现 7×24 小时持续运行。

**架构设计：**
- 监控进程持续运行，以 `Asia/Shanghai` 每日 00:00 为边界归档一个 Session；隔夜持仓会自动继承到新 Session
- 所有交易数据持久化到 NAS 共享文件夹，断电不丢失
- 通过飞书 Webhook 实时推送信号到手机
- 定期从 NAS 取回数据文件进行分析

---

## 二、前置准备

### 2.1 本地电脑准备

需要安装：
- **Git**（用于版本管理）
- **SCP/SFTP 工具**（如 WinSCP、FileZilla，用于传文件到 NAS）
- 或者飞牛 NAS 自带的文件管理器

### 2.2 飞牛 NAS 准备

1. 确认 Docker 已安装（飞牛应用中心 → Docker）
2. 创建一个共享文件夹用于部署，例如：`/vol1/docker/bi-agent`
   - 飞牛文件管理器中操作：新建共享文件夹 → 命名 `docker`（如果还没有）
   - 在 `docker` 下新建文件夹 `bi-agent`

### 2.3 获取必要密钥

- **OpenAI API Key**（或中转站 Key）
- **飞书 Webhook URL**（推荐，用于手机接收信号通知）

---

## 三、文件传输到 NAS

### 3.1 需要传输的文件

从本地项目目录传输以下文件到 NAS 的 `/vol1/docker/bi-agent/`：

```
bi-agent/
├── Dockerfile                    # 已更新，支持 monitor 模式
├── docker-compose.nas.yml        # NAS 专用编排文件
├── .env.nas                      # 环境变量模板
├── package.json                  # 依赖声明
├── deploy/
│   └── entrypoint.sh             # 容器启动脚本
├── src/                          # 全部源码
│   ├── aiAnalyzer.js
│   ├── binanceClient.js
│   ├── config.js
│   ├── directionEngine.js
│   ├── env.js
│   ├── feishuNotifier.js
│   ├── formalSignalRules.js
│   ├── indicators.js
│   ├── marketFusion.js
│   ├── marketSignalClassifier.js
│   ├── scanner.js
│   ├── server.js
│   ├── signalEngine.js
│   ├── signalEvaluator.js
│   ├── store.js
│   ├── strategyValidation.js
│   ├── swingEngine.js
│   ├── tradeMetrics.js
│   ├── utils.js
│   ├── watchLifecycle.js
│   ├── watchSignalEngine.js
│   └── watcher.js
├── scripts/
│   └── formalSignalPaperMonitor.js  # 核心监控脚本
└── public/                       # Web UI（可选）
    ├── app.js
    ├── index.html
    └── styles.css
```

### 3.2 传输方式

**方式 A：通过 WinSCP / FileZilla（推荐）**
1. 连接 NAS（SFTP 协议，端口 22）
2. 将上述文件按目录结构上传到 `/vol1/docker/bi-agent/`

**方式 B：通过飞牛文件管理器**
1. 将项目打包为 zip（排除 `node_modules`、`data`、`.git` 目录）
2. 上传 zip 到 NAS
3. 通过 NAS 的压缩解压功能解压

**方式 C：通过 Git（如果 NAS 支持 SSH）**
```bash
# 在 NAS SSH 终端中
cd /vol1/docker
git clone <your-repo-url> bi-agent
```

---

## 四、配置环境变量

### 4.1 在 NAS 上创建 .env 文件

SSH 登录 NAS 或通过文件管理器：

```bash
# SSH 登录 NAS 后
cd /vol1/docker/bi-agent
cp .env.nas .env
```

### 4.2 编辑 .env，填写必填项

```bash
vi .env    # 或用 nano .env
```

**必须修改的配置：**

| 配置项 | 说明 | 示例 |
|--------|------|------|
| `OPENAI_API_KEY` | AI 分析用的 API Key | `sk-xxxx...` |
| `FEISHU_WEBHOOK_URL` | 飞书机器人 Webhook | `https://open.feishu.cn/...` |
| `FEISHU_ENABLED` | 是否启用飞书通知 | `true` |

**NAS 运行已优化的配置（无需修改）：**

| 配置项 | 值 | 说明 |
|--------|-----|------|
| `FORMAL_MONITOR_DURATION_SECONDS` | `0` | 持续运行；日报独立归档 |
| `FORMAL_MONITOR_TIMEZONE` | `Asia/Shanghai` | 每日 00:00 的自然日边界 |
| `FORMAL_MONITOR_SCAN_SECONDS` | `300` | 5 分钟扫描一次 |
| `FORMAL_MONITOR_POLL_SECONDS` | `30` | 持仓 30 秒轮询 |
| `FORMAL_MONITOR_MAX_TRADES` | `200` | 单自然日最大交易数 |
| `FORMAL_MONITOR_ACCOUNT_RISK_PER_TRADE_PERCENT` | `0.5` | 每笔目标账户风险；仓位上限可能使实际风险更低 |
| `FORMAL_MONITOR_MAX_PORTFOLIO_RISK_PERCENT` | `2.0` | 所有未平仓仓位的风险总上限 |
| `FORMAL_MONITOR_MAX_SAME_SIDE_OPEN` | `3` | 同方向最大持仓数，降低市场 Beta 集中度 |
| `FORMAL_MONITOR_MAX_POSITION_SIZE_PERCENT` | `35` | 单仓名义规模占账户权益上限 |
| `FORMAL_MONITOR_MAX_PORTFOLIO_POSITION_SIZE_PERCENT` | `100` | 组合名义规模占账户权益上限 |
| `FORMAL_MONITOR_MAX_SESSION_DRAWDOWN_PERCENT` | `8` | 账户权益峰谷回撤达到阈值后停止本 session 开仓 |
| `FORMAL_MONITOR_MAX_DAILY_LOSS_PERCENT` | `3` | 自然日内账户亏损达到阈值后暂停至下一自然日 |

风险护栏触发后，监控器仍会扫描市场、更新候选与诊断并管理已有持仓，只停止新开仓。输出 JSON 的 `summary.portfolioRisk`、`summary.accountPerformance` 和 `riskGuard` 字段用于核对账户收益、真实峰谷回撤及开仓阻断原因。

---

## 五、构建与启动

### 5.1 SSH 登录 NAS

```bash
ssh your-username@nas-ip-address
```

### 5.2 进入项目目录

```bash
cd /vol1/docker/bi-agent
```

### 5.3 重命名 compose 文件

```bash
cp docker-compose.nas.yml docker-compose.yml
```

### 5.4 构建镜像

```bash
docker compose build
```

首次构建约需 2-5 分钟（需下载 Node.js 24 基础镜像）。

### 5.5 启动容器

```bash
# 后台启动
docker compose up -d

# 查看启动日志
docker compose logs -f
```

### 5.6 验证运行

```bash
# 查看容器状态
docker compose ps

# 查看实时日志
docker compose logs -f bi-agent-monitor

# 检查数据文件是否生成
ls -la data/formal-signal-monitor/
```

正常启动后你会看到类似输出：
```
[entrypoint] START_MODE=monitor
[entrypoint] NODE_ENV=production
[formal-monitor] output /app/data/formal-signal-monitor/2026-07-10T...json
[formal-monitor] options {...}
```

---

## 六、日常运维

### 6.1 查看运行状态

```bash
# 容器状态
docker compose ps

# 最近 100 行日志
docker compose logs --tail=100 bi-agent-monitor

# 实时监控日志
docker compose logs -f bi-agent-monitor
```

### 6.2 停止 / 重启

```bash
# 优雅停止（会等待当前操作完成）
docker compose stop

# 重启
docker compose restart

# 完全停止并删除容器（数据不丢失）
docker compose down
```

### 6.3 查看当前 session 数据

```bash
# 最新状态快照
cat data/formal-signal-monitor/latest.json | head -50

# 查看交易摘要
cat data/formal-signal-monitor/latest.json | grep -A 20 '"summary"'
```

---

## 七、数据收集与分析

### 7.1 需要定期获取的数据

**核心数据文件（从 NAS 取回）：**

| 文件路径 | 说明 | 获取频率 |
|----------|------|----------|
| `data/formal-signal-monitor/latest.json` | 当前自然日实时快照 | 每天 |
| `data/formal-signal-monitor/runtime.json` | 重启恢复检查点，不能删除或覆盖 | 每天 |
| `data/formal-signal-monitor/session-YYYY-MM-DD.json` | 每个自然日的完整交易记录 | 每周 |
| Docker 日志 | 运行日志和错误信息 | 出问题时 |

### 7.2 数据文件格式

`latest.json` 包含当前自然日完整的运行状态；`runtime.json` 用于容器更新/重启后恢复，不应手动修改。

```json
{
  "mode": "formal_signal_spot_price_as_futures_proxy",
  "startedAt": "2026-07-10T00:00:00.000Z",
  "finishedAt": null,
  "status": "running",
  "positions": [],
  "trades": [
    {
      "symbol": "BTCUSDT",
      "side": "long",
      "status": "closed",
      "openedAt": "...",
      "closedAt": "...",
      "entryPrice": 58000.0,
      "exitPrice": 59200.0,
      "grossReturnPercent": 2.07,
      "feePercent": 0.15,
      "netReturnPercent": 1.92,
      "secondsHeld": 14400
    }
  ],
  "errors": [],
  "summary": {
    "totalTrades": 12,
    "winRate": 0.58,
    "totalReturnPercent": 8.5,
    "maxDrawdownPercent": 2.1
  }
}
```

### 7.3 数据获取方式

**方式 A：通过 SCP 下载（推荐）**
```bash
# 在本地电脑执行
scp -r your-username@nas-ip:/vol1/docker/bi-agent/data/formal-signal-monitor/ ./local-data/
```

**方式 B：通过 WinSCP / FileZilla**
直接拖拽 `data/formal-signal-monitor/` 目录到本地。

**方式 C：打包后下载**
```bash
# 在 NAS SSH 中打包
cd /vol1/docker/bi-agent/data
tar czf monitor-data-$(date +%Y%m%d).tar.gz formal-signal-monitor/

# 然后下载 tar 包
```

### 7.4 分析时需要关注的关键指标

取回数据后，发给我分析时重点关注：

1. **交易统计**：`summary.totalTrades`、`summary.winRate`、`summary.totalReturnPercent`
2. **最大回撤**：`summary.maxDrawdownPercent`（超过 8% 需要调整）
3. **错误日志**：`errors` 数组（排查异常）
4. **持仓分布**：`positions` 数组（是否有长时间未平仓）
5. **每笔交易明细**：`trades` 数组（分析胜/败原因）

---

## 八、系统更新流程

### 8.1 安全更新步骤（不丢数据）

```bash
# 1. SSH 登录 NAS
ssh your-username@nas-ip-address
cd /vol1/docker/bi-agent

# 2. 备份当前数据（重要！）
cp -r data data-backup-$(date +%Y%m%d)

# 3. 停止容器（数据在 volume 中，不受影响）
docker compose stop

# 4. 更新代码文件（通过 SCP 上传新文件）
#    只需更新变化的文件，通常是：
#    - src/ 目录下的源码
#    - scripts/formalSignalPaperMonitor.js
#    - Dockerfile（如果有改动）

# 5. 重新构建镜像
docker compose build

# 6. 启动
docker compose up -d

# 7. 验证
docker compose logs -f bi-agent-monitor
```

### 8.2 回滚方案

如果新版本有问题：
```bash
docker compose stop
# 恢复备份数据
rm -rf data
mv data-backup-YYYYMMDD data
# 重新构建旧版本镜像
docker compose build
docker compose up -d
```

### 8.3 配置热更新

只修改环境变量（不改代码）时无需重建镜像：
```bash
# 编辑 .env
vi .env

# 重启容器使配置生效
docker compose restart
```

不要用仓库中的 `.env.nas` 覆盖已经运行的 `.env`。保留 NAS 上的密钥、通知配置和运行参数，只合并新增或明确调整的键。

### 8.4 信号质量修复后的推荐配置

以下配置保持硬风控，不再使用已经验证表现较差的宽松门槛：

```dotenv
FORMAL_MONITOR_MIN_SCORE=62
FORMAL_MONITOR_MIN_EDGE=22
FORMAL_MONITOR_EXECUTION_MIN_SCORE=60
FORMAL_MONITOR_EXECUTION_MIN_EDGE=18
FORMAL_MONITOR_EXECUTION_MAX_SOFT_FAILURES=1
FORMAL_MONITOR_MAX_ATR_PERCENT=6
FORMAL_MONITOR_OBSERVATION_LOG_LIMIT=3
FORMAL_MONITOR_SHADOW_PROFILES=control:minEdge=22,minScore=62,targetAtrFraction=2.0,stopAtrFraction=1.2,minRewardRisk=1.5;frequency_probe:minEdge=20,minScore=60,targetAtrFraction=2.0,stopAtrFraction=1.2,minRewardRisk=1.35
```

若需要把高分观察候选发送到飞书，可在现有飞书配置中加入 `watch`：

```dotenv
FEISHU_MARKET_SIGNAL_LEVELS=formal,watch
FEISHU_HIGH_PRECISION_ONLY=true
```

`watch` 只表示观察候选，不是开仓指令。通知仍受高精度阈值和冷却时间约束。

更新后至少验证：

```bash
docker compose up -d --build
docker compose logs --tail=200 bi-agent-monitor | grep -E 'hour-bias|observe|scan=|error|OPEN'
cat data/formal-signal-monitor/latest.json | grep -A 20 'observationDigest'
cat data/formal-signal-monitor/latest.json | grep -A 30 'shadowProfiles'
```

高波动时段的 `hour-bias` 应只显示仓位上限调整，不应再出现 `confirmationScans` 或 `executionMaxSoftFailures` 的动态收紧。

---

## 九、故障排查

### 9.1 容器反复重启

```bash
# 查看详细日志
docker compose logs --tail=200 bi-agent-monitor

# 常见原因：
# - API Key 无效 → 检查 .env 中 OPENAI_API_KEY
# - 网络不通 → NAS 无法访问 Binance API
# - 内存不足 → 检查 NAS 可用内存
```

### 9.2 没有生成数据文件

```bash
# 检查 volume 映射
docker inspect bi-agent-monitor | grep -A 5 Mounts

# 检查目录权限
ls -la data/
chmod -R 755 data/
```

### 9.3 飞书收不到通知

```bash
# 检查日志中的飞书相关错误
docker compose logs bi-agent-monitor | grep -i feishu

# 测试 Webhook 连通性
curl -X POST "your-webhook-url" -H "Content-Type: application/json" -d '{"msg_type":"text","content":{"text":"test"}}'
```

### 9.4 Binance API 访问失败

飞牛 NAS 在国内，可能需要：
- 确认 NAS 网络可以访问 `data-api.binance.vision` 和 `fapi.binance.com`
- 如果被封，在 `.env` 中配置备用地址：
  ```
  BINANCE_SPOT_BASE_URLS=https://api1.binance.com,https://api2.binance.com
  BINANCE_FUTURES_BASE_URLS=https://fapi.binance.com
  ```

---

## 十、定期数据同步建议

建议的数据获取节奏：

| 频率 | 操作 | 目的 |
|------|------|------|
| **每天** | 下载 `latest.json` | 查看当日交易和收益 |
| **每 3 天** | 下载全部 `*.json` + 日志 | 发给我做趋势分析 |
| **每周** | 完整备份 `data/` 目录 | 数据归档 |
| **异常时** | 立即导出日志 | 排查问题 |

**发给我分析时，请提供：**
1. `latest.json`（必须）
2. 最近 3 天的 session JSON 文件
3. `docker compose logs --tail=500` 的输出
4. 任何你观察到的异常现象描述

---

## 十一、Monitor 状态解释、诊断与持久日志

### 11.1 页面状态的含义

- “当前暂无持仓”表示 `positions=[]`，不表示数据文件读取失败或持仓被删除。
- `OBSERVE_ONLY` 表示风险护栏暂时禁止新开仓。页面会显示触发原因和预计恢复时间；`session_max_drawdown` 没有自动恢复时间，本 Session 不再开仓。
- “部分减仓”是同一主仓位的执行记录，不应当作一笔新的独立交易；概览会分别显示完整平仓数和部分减仓数。
- 数据源状态会区分请求超时、DNS 临时解析失败（如 `EAI_AGAIN`）、HTTP 451 地区/法律限制以及其他网络错误。

### 11.2 只读诊断端点

```bash
curl -s http://127.0.0.1:4173/api/monitor/diagnostics
```

端点只返回容器内实际读取的 `latest.json`、`runtime.json` 路径、大小、修改时间、SHA256 和一致性结果。它不会返回 `.env`、API Key、飞书配置、原始交易内容或日志内容。路径是容器路径 `/app/data/...`，不是 NAS 宿主机路径。

### 11.3 跨容器持久日志

Monitor 仍然保留 `docker compose logs` 输出，同时将副本写入：

```text
data/logs/formal-monitor/formal-monitor.log
data/logs/formal-monitor/formal-monitor.log.1
...
data/logs/formal-monitor/formal-monitor.log.14
```

单文件上限默认 10MB，最多保留 14 个归档，总量约 150MB。文件位于现有 `./data:/app/data` bind mount 中，重建容器后仍然保留。

```bash
tail -f data/logs/formal-monitor/formal-monitor.log
du -sh data/logs/formal-monitor
```

文件日志不可写时，系统只会在 stderr 告警一次并继续监控，不会因为日志故障停止交易监控。不要把启动命令改成 `node ... | tee`，否则可能破坏 SIGTERM checkpoint。

### 11.4 更新后的验收

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 bi-agent-monitor
curl -s http://127.0.0.1:4173/api/monitor/status
curl -s http://127.0.0.1:4173/api/monitor/diagnostics
tail -n 100 data/logs/formal-monitor/formal-monitor.log
```

NAS 路径区分大小写。本文早期示例使用 `/vol1/docker/bi-agent`；当前部署实际为 `/vol1/docker/Bi-Agent` 时，所有 `cd`、备份和同步命令都必须使用实际大小写路径。
