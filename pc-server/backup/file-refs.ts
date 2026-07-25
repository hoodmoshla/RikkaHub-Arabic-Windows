// backup/file-refs.ts — 附件引用扫描/改写与内容指纹(备份 2.0 批5)。
// PC 全系统对附件的引用只有一种形态:/api/files/<id>/content(api/handlers/files.ts 路由;
// 消息 part、工具输出、生图画廊 url、助手头像均是)。generatedImages.fileId 是唯一的
// 纯数字引用,由调用方单独处理。

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { JsonValue } from "../foundation/types";

const PC_FILE_URL_RE = /\/api\/files\/(\d+)\/content/g;

export function hashBytesSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hashFileSha256(path: string): string | null {
  try {
    return hashBytesSha256(readFileSync(path));
  } catch {
    return null;
  }
}

/** 从任意 JSON 文本中收集被引用的文件 id(只增,调用方负责并集)。 */
export function collectPcFileRefs(jsonText: string, into: Set<number>): void {
  for (const m of jsonText.matchAll(PC_FILE_URL_RE)) into.add(Number(m[1]));
}

/** 深改写任意 JSON 值中的 /api/files/<id>/content 引用;map 未命中的 id 原样保留。 */
export function rewritePcFileUrlsDeep(value: JsonValue, idMap: Map<number, number>): JsonValue {
  if (typeof value === "string") {
    return value.replace(PC_FILE_URL_RE, (whole, idStr: string) => {
      const mapped = idMap.get(Number(idStr));
      return mapped === undefined ? whole : `/api/files/${mapped}/content`;
    });
  }
  if (Array.isArray(value)) return value.map((v) => rewritePcFileUrlsDeep(v, idMap));
  if (value && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewritePcFileUrlsDeep(v as JsonValue, idMap);
    return out;
  }
  return value;
}
