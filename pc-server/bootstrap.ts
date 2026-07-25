// bootstrap.ts — 显式启动编排(全面审查 0-3/8-4/1-8)
// 此前整个启动序列 = "server.ts import 块的求值顺序 + 三处模块顶层副作用"
// (state-load 装载迁移、conversations 定时器、api/sse 接线),约束只靠 import 顺序
// 隐式保证,且任何脚本/测试 import 到 state-load 就会执行真实磁盘迁移。
// 现在收敛为单一编排点:server.ts 在解析端口/Bun.serve 之前调用一次。

import { applyEffectiveProxy, installProxyFetchInterceptor } from "./foundation/net";
import { saveState, setState, state } from "./persistence/json-store";
import { loadState } from "./persistence/state-load";
import { initConversationsRuntime } from "./conversations";
import { initSseWiring } from "./api/sse";

export function bootstrap(): void {
  // 1) 状态装载 + 一次性迁移链(SQLite 灌库、记忆拆分、附件去重、.tmp 清扫都在 loadState 内)。
  setState(loadState());
  state.launchCount += 1;

  // 2) 代理拦截器:必须在首次 fetch 之前安装(Bun.serve 接受请求之前),
  //    否则首个请求会触发 Bun 的 env 快照锁定,之后改代理不生效。
  installProxyFetchInterceptor(() => state.settings.proxyConfig);
  applyEffectiveProxy(state.settings.proxyConfig);

  // 3) 会话运行时:working set 判据接线 + 驻留清扫定时器。
  initConversationsRuntime();

  // 4) SSE 接线:working set 的"界面正开着"判据 + 错误中心 SSE 广播。
  initSseWiring();

  // 5) 1-8:启动规范化结果(normalizeState 的 backfill/迁移标记)与 launchCount 立即落盘。
  //    此前只活在内存,纯只读会话(启动→看历史→退出)每次启动重跑全部规范化,
  //    launchCount 在这类会话中永不落盘。
  saveState();
}
