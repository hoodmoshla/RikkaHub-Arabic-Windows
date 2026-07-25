// api/handlers/errors.ts — 应用错误通道路由(P2-1 批2):errors/stream、errors/recent、errors/clear。
// 纪律:只做通道数据的出入口;错误的产生与合并语义在 observability/app-errors.ts。

import { clearAppErrors, recentAppErrors } from "../../observability/app-errors";
import { json } from "../request";
import { errorClients, openSse } from "../sse";

export async function handleErrorRoutes(request: Request, _url: URL, path: string): Promise<Response | null> {
  if (path === "errors/stream") {
    // 连接即推快照(仅入 store 不弹 toast,前端契约),增量走 app_error 事件
    return openSse(
      () => [["snapshot", { type: "snapshot", errors: recentAppErrors() }]],
      (controller) => {
        errorClients.add(controller);
        return () => errorClients.delete(controller);
      },
    );
  }
  if (path === "errors/recent" && request.method === "GET") {
    return json({ errors: recentAppErrors() });
  }
  if (path === "errors/clear" && request.method === "POST") {
    clearAppErrors();
    return json({ status: "ok" });
  }
  return null;
}
