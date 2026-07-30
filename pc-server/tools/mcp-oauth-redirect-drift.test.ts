// A4 回归(专题9复查):MCP OAuth 端口漂移防护。DCR 注册把 redirect_uris 固化成注册时
// 的 localhost:<端口>;端口顺延/手改后,旧 clientId 重新授权会被授权服务器以
// invalid redirect_uri 拒绝且报错在浏览器侧。startMcpOAuth 现依据 redirectUriDriftAction
// 决策:漂移且支持 DCR → 换新身份重注册;不支持 → 应用内明确报错;
// 预配置/旧状态(无 redirectUri 记录) → 保持不动。
import { describe, expect, test } from "bun:test";

import { redirectUriDriftAction } from "./mcp-oauth";

const CUR = "http://localhost:8090/api/mcp/oauth/callback";
const OLD = "http://localhost:8080/api/mcp/oauth/callback";

describe("redirectUriDriftAction", () => {
  test("无既有授权状态:keep(走常规首次注册)", () => {
    expect(redirectUriDriftAction(null, CUR, true)).toBe("keep");
  });

  test("回调地址未变:keep(沿用旧 clientId)", () => {
    expect(redirectUriDriftAction({ clientId: "c1", redirectUri: CUR }, CUR, true)).toBe("keep");
  });

  test("漂移 + 支持动态注册:reregister(换新身份,旧授权作废属预期)", () => {
    expect(redirectUriDriftAction({ clientId: "c1", redirectUri: OLD }, CUR, true)).toBe("reregister");
  });

  test("漂移 + 不支持动态注册:fail(应用内报错,不送用户去浏览器撞墙)", () => {
    expect(redirectUriDriftAction({ clientId: "c1", redirectUri: OLD }, CUR, false)).toBe("fail");
  });

  test("redirectUri 无记录(预配置 clientId/本字段引入前的旧授权):keep,不擅自换身份", () => {
    expect(redirectUriDriftAction({ clientId: "c1" }, CUR, true)).toBe("keep");
    expect(redirectUriDriftAction({ clientId: "c1", redirectUri: null }, CUR, false)).toBe("keep");
  });
});
