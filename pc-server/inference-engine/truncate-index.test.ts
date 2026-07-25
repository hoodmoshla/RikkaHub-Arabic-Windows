// 2-2 回归:truncateIndex(安卓"清除上下文"分割线)必须在上下文组装处生效——
// index 之前的节点不进上下文。此前全链路只写不读,是纯装饰契约。
import { describe, expect, test } from "bun:test";

import { applyTruncateIndex } from "./conversation-encoding";

const nodes = ["n0", "n1", "n2", "n3"];

describe("applyTruncateIndex(2-2)", () => {
  test("truncateIndex=-1(默认):全部节点进上下文", () => {
    expect(applyTruncateIndex(nodes, -1)).toEqual(nodes);
  });

  test("truncateIndex=0(compress 后/安卓未截断):全部节点进上下文", () => {
    expect(applyTruncateIndex(nodes, 0)).toEqual(nodes);
  });

  test("truncateIndex=2:分割线之前的 n0/n1 被排除", () => {
    expect(applyTruncateIndex(nodes, 2)).toEqual(["n2", "n3"]);
  });

  test("truncateIndex=节点数:上下文为空(分割线在末尾)", () => {
    expect(applyTruncateIndex(nodes, 4)).toEqual([]);
  });

  test("truncateIndex 超出节点数:不越界,上下文为空", () => {
    expect(applyTruncateIndex(nodes, 99)).toEqual([]);
  });
});
