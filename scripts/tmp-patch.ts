import { readFileSync, writeFileSync } from "node:fs";

export function patch(path: string, edits: Array<[string, string]>): void {
  const raw = readFileSync(path, "utf8");
  const crlf = raw.includes("\r\n");
  let text = raw.replaceAll("\r\n", "\n");
  for (const [oldStr, newStr] of edits) {
    const count = text.split(oldStr).length - 1;
    if (count !== 1) {
      console.error(`${path}: 匹配异常(${count}): ${JSON.stringify(oldStr.slice(0, 80))}`);
      process.exit(1);
    }
    text = text.replace(oldStr, newStr);
  }
  writeFileSync(path, crlf ? text.replaceAll("\n", "\r\n") : text);
  console.log(path, "OK");
}
