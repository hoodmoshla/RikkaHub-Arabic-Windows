// app-config/analytics.ts — 匿名 DAU 统计（一启动一 ping，绝不打扰用户，详见下方设计准则注释）
// 纪律：搬迁自 server.ts（阶段 5.3h）。仅发送当日计数——设备 UUID、日期、版本、OS,外加:
//   mc = 消息数        hb = 心跳数(≈ 当日窗口激活时长 / 10 分钟,见 markUiActivity)
//   er = provider 失败  fs/ft/fm/fi = 搜索 / TTS / MCP / 图像生成 使用次数
// 不采集用户内容、IP、模型名、文件名、查询词。服务端只按 MAX 合并当日计数,每天归零。

import { readFileSync, writeFileSync } from "node:fs";
import { deviceIdPath } from "../foundation/paths";
import { APP_VERSION } from "../updates/index";

const ANALYTICS_ENDPOINT = "https://rikkahub-desktop.pages.dev/ping";
let analyticsDeviceId = "";
let analyticsMsgCount = 0;
let analyticsHbCount = 0;      // 心跳数:活跃 tick +1,≈ 当日【窗口激活】时长 / 10 分钟
let analyticsErrCount = 0;     // provider 请求失败数(不含用户主动中断)
let analyticsSearchCount = 0;  // search_web / scrape_web 执行次数
let analyticsTtsCount = 0;     // TTS 朗读次数
let analyticsMcpCount = 0;     // MCP 工具调用次数
let analyticsImgCount = 0;     // 图像生成次数

// 专题6:hb 的口径是"用户实际在用"而非"进程在线"。此前每次 ping 无条件 +1,
// 而 ping 只要 server 进程活着就发——托盘常驻/Docker 7×24 部署把"使用时长"灌成
// "进程在线时长"(dashboard 曾出现日均 645 分钟的荒谬均值)。现在由前端在窗口
// 可见且聚焦时定期上报活动信标(POST /api/activity → markUiActivity),每个
// 10 分钟 tick 只有收到过信标才计 1 跳。无 UI 交互的空转进程 hb 恒为 0。
let lastUiActivityAt = 0;
export function markUiActivity(): void { lastUiActivityAt = Date.now(); }

// 3.5c-4: 埋点分散在各域模块(会话/工具/媒体),经函数递增计数(let 变量无法跨模块赋值)。
export function bumpAnalyticsMsgCount() { analyticsMsgCount++; }
export function bumpAnalyticsErrCount() { analyticsErrCount++; }
export function bumpAnalyticsSearchCount() { analyticsSearchCount++; }
export function bumpAnalyticsTtsCount() { analyticsTtsCount++; }
export function bumpAnalyticsMcpCount() { analyticsMcpCount++; }
export function bumpAnalyticsImgCount() { analyticsImgCount++; }

function resetAnalyticsCounters(): void {
  analyticsMsgCount = 0;
  analyticsHbCount = 0;
  analyticsErrCount = 0;
  analyticsSearchCount = 0;
  analyticsTtsCount = 0;
  analyticsMcpCount = 0;
  analyticsImgCount = 0;
}

function readOrCreateDeviceId(): string {
  try { return readFileSync(deviceIdPath, "utf-8").trim(); } catch { /* not found */ }
  const id = crypto.randomUUID();
  try { writeFileSync(deviceIdPath, id); } catch { /* best-effort */ }
  return id;
}

function localDateStr(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function analyticsOs(): string {
  // 区分 win / mac / linux —— Docker 容器内 process.platform === "linux",
  // 算 Linux 用户,合理(Docker 镜像也是基于 Linux 二进制)。
  if (process.platform === "darwin") return "mac";
  if (process.platform === "linux") return "linux";
  return "win";
}

function sendAnalyticsPing(): void {
  if (!analyticsDeviceId) return;
  const url = `${ANALYTICS_ENDPOINT}?id=${encodeURIComponent(analyticsDeviceId)}`
    + `&d=${localDateStr()}`
    + `&v=${encodeURIComponent(APP_VERSION)}`
    + `&os=${analyticsOs()}`
    + `&mc=${analyticsMsgCount}`
    + `&hb=${analyticsHbCount}`
    + `&er=${analyticsErrCount}`
    + `&fs=${analyticsSearchCount}`
    + `&ft=${analyticsTtsCount}`
    + `&fm=${analyticsMcpCount}`
    + `&fi=${analyticsImgCount}`;
  // 三重静默防御:
  //   (1) try/catch 包裹同步部分,防 fetch() 同步抛错(比如 URL 不合法)
  //   (2) AbortSignal.timeout 限制网络等待,DNS 失败/连接超时都会被吞
  //   (3) .then/.catch 双 noop 确保 promise 既不打印未捕获 reject,也不让
  //       响应体引起任何后续处理
  try {
    fetch(url, { method: "GET", signal: AbortSignal.timeout(5000) })
      .then(() => {}, () => {});
  } catch { /* fire-and-forget — never block, never warn */ }
}

export function startAnalytics(): void {
  // 同步部分(读 device-id、设置 interval)绝不可能抛错;唯一可能的失败点是
  // fetch,已在 sendAnalyticsPing 内部隔离。这里整体再加一层 try/catch 兜底,
  // 防御未来代码改动时引入意外异常 —— analytics 永远不应该让 server 启动失败。
  try {
    analyticsDeviceId = readOrCreateDeviceId();
    const today = localDateStr();
    let lastDate = today;
    sendAnalyticsPing(); // startup ping(DAU 信号,不计时长——启动 ≠ 在用)
    let lastTickAt = Date.now();
    setInterval(() => {
      const now = localDateStr();
      if (now !== lastDate) { resetAnalyticsCounters(); lastDate = now; }
      // 本 tick 周期内有 UI 活动信标才算一跳(10 分钟粒度的激活时长估算)。
      if (lastUiActivityAt >= lastTickAt) analyticsHbCount++;
      lastTickAt = Date.now();
      sendAnalyticsPing();
    }, 10 * 60 * 1000); // every 10 minutes
  } catch { /* analytics must never break the app */ }
}
