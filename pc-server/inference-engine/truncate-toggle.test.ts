// 产品决策①回归:truncate 端点的切换/显式语义(nextTruncateIndex 纯函数)。
// 编码侧消费(applyTruncateIndex)见 truncate-index.test.ts。
import { describe, expect, test } from "bun:test";

import { nextTruncateIndex } from "../conversations";

describe("nextTruncateIndex(产品决策①)", () => {
  test("未截断 → 截到当前节点数(清除上下文)", () => {
    expect(nextTruncateIndex(-1, 5)).toBe(5);
    expect(nextTruncateIndex(0, 5)).toBe(5);
  });

  test("已截到末尾 → 撤销(-1,安卓切换语义)", () => {
    expect(nextTruncateIndex(5, 5)).toBe(-1);
  });

  test("截断点在中间(之后又聊过)→ 再清除移到新末尾", () => {
    expect(nextTruncateIndex(3, 7)).toBe(7);
  });

  test("显式 index:恢复(-1)与钳制到 [-1, nodeCount]", () => {
    expect(nextTruncateIndex(5, 5, -1)).toBe(-1);
    expect(nextTruncateIndex(-1, 5, 99)).toBe(5);
    expect(nextTruncateIndex(-1, 5, -42)).toBe(-1);
    expect(nextTruncateIndex(-1, 5, 2.9)).toBe(2);
  });
});
