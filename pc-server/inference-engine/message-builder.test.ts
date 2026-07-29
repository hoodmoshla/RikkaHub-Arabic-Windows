// inference-engine/message-builder 纯路径单元测试（5.5 测试补强）。
// 消息编码是发给上游 Provider 的最终形状（OpenAI chat / Response API / Claude），
// 契约冻结：text 折叠、tool 边界分组、OCR 降级、data: URL 透传。
// 注：document part 路径会触 state.files（运行时状态），由端到端 smoke 覆盖，此处不测。
import { describe, expect, test } from "bun:test";

import {
  apiContentFromParts,
  claudeContentFromApiContent,
  dataUrlForMessageUrl,
  documentPartsFirst,
  groupAssistantPartsByToolBoundary,
  parseDataUrl,
  responseApiContentFromUiParts,
  supportsInputModality,
} from "./message-builder";
import type { MessagePart, Model } from "../foundation/types";

const textModel = { inputModalities: ["TEXT"] } as unknown as Model;
const visionModel = { inputModalities: ["TEXT", "IMAGE"] } as unknown as Model;

describe("dataUrlForMessageUrl / parseDataUrl", () => {
  test("data: 与 http(s) URL 直接透传，不查文件表", () => {
    expect(dataUrlForMessageUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(dataUrlForMessageUrl("https://x.com/a.png")).toBe("https://x.com/a.png");
    expect(dataUrlForMessageUrl("")).toBe("");
  });

  test("parseDataUrl 解析 mime 与 base64 数据", () => {
    expect(parseDataUrl("data:image/png;base64,QUJD")).toEqual({ mime: "image/png", data: "QUJD" });
    expect(parseDataUrl("not-a-data-url")).toBeNull();
  });
});

describe("apiContentFromParts", () => {
  test("空 parts 返回 fallback，单 text 折叠为字符串", () => {
    expect(apiContentFromParts([], "fallback")).toBe("fallback");
    expect(apiContentFromParts([{ type: "text", text: "hi" }])).toBe("hi");
  });

  test("多 part 返回数组，空 text 被丢弃", () => {
    const content = apiContentFromParts([
      { type: "text", text: "a" },
      { type: "text", text: "" },
      { type: "image", url: "data:image/png;base64,AA" },
    ]);
    expect(content).toEqual([
      { type: "text", text: "a" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
    ]);
  });

  test("模型不支持 IMAGE 且有 OCR 文本时，图片替换为 OCR 文本（Android OcrTransformer 对齐）", () => {
    const parts: MessagePart[] = [
      { type: "image", url: "data:image/png;base64,AA", metadata: { ocrText: "scanned" } },
    ];
    const stripped = apiContentFromParts(parts, "", textModel);
    expect(stripped).toBe("<image_file_ocr>\nscanned\n</image_file_ocr>");
    const kept = apiContentFromParts(parts, "", visionModel) as Array<{ type: string }>;
    expect(kept.map((p) => p.type)).toEqual(["image_url", "text"]);
  });

  test("audio/video 降级为文本占位", () => {
    expect(apiContentFromParts([{ type: "audio", url: "u" }])).toBe("[audio: u]");
  });
});

describe("documentPartsFirst", () => {
  test("issue6:文档 part 前置(对齐安卓 add(0, prompt)),其余保持稳定顺序", () => {
    const question = { type: "text", text: "问题" };
    const doc1 = { type: "document", url: "/api/files/1/content", fileName: "a.txt" };
    const doc2 = { type: "document", url: "/api/files/2/content", fileName: "b.txt" };
    const image = { type: "image", url: "data:image/png;base64,AA" };
    expect(documentPartsFirst([question, doc1, image, doc2])).toEqual([doc1, doc2, question, image]);
  });

  test("无文档时原样返回(同一引用,零开销)", () => {
    const parts = [{ type: "text", text: "hi" }];
    expect(documentPartsFirst(parts)).toBe(parts);
  });
});

describe("groupAssistantPartsByToolBoundary", () => {
  test("以 tool part 为边界切分 content/tools 组，保持顺序", () => {
    const groups = groupAssistantPartsByToolBoundary([
      { type: "text", text: "before" },
      { type: "tool", toolCallId: "1", toolName: "t", input: "{}", output: [], approvalState: { type: "auto" } },
      { type: "tool", toolCallId: "2", toolName: "t", input: "{}", output: [], approvalState: { type: "auto" } },
      { type: "text", text: "after" },
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["content", "tools", "content"]);
    expect((groups[1] as { tools: unknown[] }).tools).toHaveLength(2);
  });

  test("空输入返回空组", () => {
    expect(groupAssistantPartsByToolBoundary([])).toEqual([]);
  });
});

describe("responseApiContentFromUiParts", () => {
  test("单 text 折叠为字符串，多 part 按角色映射 input_text/output_text", () => {
    expect(responseApiContentFromUiParts([{ type: "text", text: "q" }], "user")).toBe("q");
    expect(responseApiContentFromUiParts([{ type: "text", text: "a" }], "assistant")).toBe("a");
    const multi = responseApiContentFromUiParts(
      [{ type: "text", text: "q" }, { type: "text", text: "r" }],
      "user",
    );
    expect(multi).toEqual([
      { type: "input_text", text: "q" },
      { type: "input_text", text: "r" },
    ]);
  });

  test("已是 API 形状的 image_url part 透传为 input_image", () => {
    const content = responseApiContentFromUiParts(
      [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }],
      "user",
    );
    expect(content).toEqual([{ type: "input_image", image_url: "data:image/png;base64,AA" }]);
  });

  test("未知 part 被过滤", () => {
    expect(responseApiContentFromUiParts([{ type: "mystery" }, "junk"], "user")).toEqual([]);
  });
});

describe("claudeContentFromApiContent", () => {
  test("字符串直接透传", () => {
    expect(claudeContentFromApiContent("plain")).toBe("plain");
  });

  test("image_url data-url 转 Claude base64 source，text 保留", () => {
    const content = claudeContentFromApiContent([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
    ]);
    expect(content).toEqual([
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
    ]);
  });

  test("非 data-url 图片降级为文本占位，未知 part JSON 兜底", () => {
    const content = claudeContentFromApiContent([
      { type: "image_url", image_url: { url: "https://x/a.png" } },
      { type: "weird", x: 1 },
    ]) as Array<{ type: string; text: string }>;
    expect(content[0]).toEqual({ type: "text", text: "[Image: https://x/a.png]" });
    expect(content[1].type).toBe("text");
    expect(JSON.parse(content[1].text)).toEqual({ type: "weird", x: 1 });
  });
});

describe("supportsInputModality", () => {
  test("大小写不敏感，缺省为空数组", () => {
    expect(supportsInputModality(visionModel, "image")).toBe(true);
    expect(supportsInputModality(textModel, "IMAGE")).toBe(false);
    expect(supportsInputModality({} as Model, "TEXT")).toBe(false);
  });
});
