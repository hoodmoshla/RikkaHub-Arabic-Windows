// 使用时长活动信标(专题6)。
//
// 后端 analytics 的 hb(≈使用时长/10min)口径是"用户实际在用",判据为窗口可见且
// 聚焦——托盘常驻、后台标签页、无头部署都不该计时。本模块在激活期间每 4 分钟
// POST 一次 /api/activity(小于后端 10 分钟 tick 窗口,激活期内至少落 2 拍,不会
// 因相位错过判定),失焦/隐藏即停。信标纯 fire-and-forget:失败静默,不重试、
// 不提示——统计信号永远不该打扰用户。
//
// 多窗口/多标签页同时聚焦时各自发送,后端只记"最近活动时刻",天然幂等。
import api from "./api";

const BEACON_INTERVAL_MS = 4 * 60 * 1000;

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
