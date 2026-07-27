// parseSseChunks 单测(批次六 R3-7):SSE 规范允许一个事件的 data 跨多行,join 后才是
// 完整载荷。回归点:跨行 JSON 此前被无条件按行再拆,每行解析失败被调用方容错吞掉,
// 内容整段静默丢失;单行载荷与"同一 block 塞多个单行 JSON 事件"的不规范上游行为不变。
import { describe, expect, test } from "bun:test";

import { parseSseChunks } from "./providers";

describe("parseSseChunks", () => {
  test("单行 data:逐块解析,行为不变", () => {
    const text = 'data: {"a":1}\n\ndata: {"b":2}\n\n';
    expect(parseSseChunks(text)).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("[DONE] 原样透传", () => {
    const text = 'data: {"a":1}\n\ndata: [DONE]\n\n';
    expect(parseSseChunks(text)).toEqual(['{"a":1}', "[DONE]"]);
  });

  test("跨行 data(美化 JSON):join 后整体返回,可被 JSON.parse", () => {
    const pretty = '{\n  "choices": [\n    {"delta": {"content": "hi"}}\n  ]\n}';
    const text = pretty.split("\n").map((line) => `data: ${line}`).join("\n") + "\n\n";
    const chunks = parseSseChunks(text);
    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks[0]!)).toEqual({ choices: [{ delta: { content: "hi" } }] });
  });

  test("同一 block 多个单行 JSON 事件(不规范上游):退回逐行拆分", () => {
    const text = 'data: {"a":1}\ndata: {"b":2}\n\n';
    expect(parseSseChunks(text)).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("CRLF 分隔与空 data 行过滤", () => {
    const text = 'data: {"a":1}\r\ndata:\r\n\r\n\r\n';
    expect(parseSseChunks(text)).toEqual(['{"a":1}']);
  });
});
