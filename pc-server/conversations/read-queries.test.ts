// read-queries 单测（DB-first 批1）：排序不变式、助手过滤、字段还原、容错。
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  conversationExistsInDb,
  countConversations,
  getConversationMeta,
  listAllConversationMetas,
  listConversationMetas,
  recentConversationMetas,
} from "./read-queries";

function seededDb(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE pc_conversation (
    id TEXT PRIMARY KEY NOT NULL, assistant_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '', truncate_index INTEGER NOT NULL DEFAULT -1,
    suggestions TEXT NOT NULL DEFAULT '[]', is_pinned INTEGER NOT NULL DEFAULT 0,
    create_at INTEGER NOT NULL, update_at INTEGER NOT NULL
  )`);
  const ins = db.prepare("INSERT INTO pc_conversation VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  // a1 三个会话：c3 最新建、c1 最旧建但最近更新；b-only 属于另一助手
  ins.run("c1", "a1", "第一", "sys", 2, '["s"]', 1, 1000, 9000);
  ins.run("c2", "a1", "第二", "", -1, "[]", 0, 2000, 2100);
  ins.run("c3", "a1", "第三", "", -1, "{bad json", 0, 3000, 3100);
  ins.run("b1", "a2", "别家", "", -1, "[]", 0, 5000, 5100);
  return db;
}

describe("listConversationMetas", () => {
  test("按 create_at 倒序（旧数组顺序等价），只含该助手，messages 恒空", () => {
    const metas = listConversationMetas(seededDb(), "a1");
    expect(metas.map((m) => m.id)).toEqual(["c3", "c2", "c1"]);
    expect(metas.every((m) => m.messages.length === 0)).toBe(true);
  });

  test("字段还原与损坏 suggestions 容错", () => {
    const metas = listConversationMetas(seededDb(), "a1");
    const c1 = metas.find((m) => m.id === "c1")!;
    expect(c1.isPinned).toBe(true);
    expect(c1.systemPrompt).toBe("sys");
    expect(c1.truncateIndex).toBe(2);
    expect(c1.chatSuggestions).toEqual(["s"]);
    const c3 = metas.find((m) => m.id === "c3")!;
    expect(c3.chatSuggestions).toEqual([]);
  });
});

describe("recentConversationMetas", () => {
  test("update_at 倒序 + 排除指定 id + limit", () => {
    const metas = recentConversationMetas(seededDb(), "a1", "c3", 10);
    expect(metas.map((m) => m.id)).toEqual(["c1", "c2"]);
    expect(recentConversationMetas(seededDb(), "a1", undefined, 1).map((m) => m.id)).toEqual(["c1"]);
  });
});

describe("辅助查询", () => {
  test("count 不分助手、exists、单条 meta", () => {
    const db = seededDb();
    expect(countConversations(db)).toBe(4);
    expect(listAllConversationMetas(db)).toHaveLength(4);
    expect(conversationExistsInDb(db, "b1")).toBe(true);
    expect(conversationExistsInDb(db, "nope")).toBe(false);
    expect(getConversationMeta(db, "c2")?.title).toBe("第二");
    expect(getConversationMeta(db, "nope")).toBeNull();
  });
});
