// 使用时长活动信标(专题6)。
//
// 使用时长的口径是"用户实际在用",判据为窗口可见且聚焦——托盘常驻、后台标签页、
// 无头部署都不该计时。本模块在激活期间每 1 分钟 POST 一次 /api/activity,失焦/
// 隐藏即停;后端按信标间隔累计活跃秒数,得到分钟级时长(真实日均可能只有 ~10
// 分钟,粗粒度格子的量化误差不可接受)。信标纯 fire-and-forget:失败静默,不重试、
// 不提示——统计信号永远不该打扰用户。回环/局域网上每天至多 1440 个微型请求,
// 网络与 CPU 代价可忽略。
//
// 多窗口/多标签页同时聚焦时各自发送,后端按到达间隔累计,天然幂等(间隔越密,
// 单拍学分越小,总和仍是墙钟时间)。
import api from "./api";

const BEACON_INTERVAL_MS = 60 * 1000;

let started = false;
let timer: number | null = null;

function isWindowActive(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

function sendBeacon(): void {
  void api.post("activity").catch(() => {});
}

function syncBeaconLoop(): void {
  if (isWindowActive()) {
    if (timer !== null) return;
    sendBeacon(); // 激活立即上报,不等首个周期
    timer = window.setInterval(sendBeacon, BEACON_INTERVAL_MS);
  } else if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}

/** 建立活动信标(幂等)。跑满页面生命周期,不提供停止句柄。 */
export function startUsageActivityBeacon(): void {
  if (started || typeof document === "undefined") return;
  started = true;
  window.addEventListener("focus", syncBeaconLoop);
  window.addEventListener("blur", syncBeaconLoop);
  document.addEventListener("visibilitychange", syncBeaconLoop);
  syncBeaconLoop();
}
