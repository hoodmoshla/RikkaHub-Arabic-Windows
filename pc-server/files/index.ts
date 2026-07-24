// files/index.ts — 文件上传、OCR、文档解析
// 纪律：负责文档解析与文件元数据读取，不直接修改业务状态。

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { StoredFile, XmlToken, MupdfModule } from "../foundation/types";
import { dataDir, filesDir } from "../foundation/paths";

// mupdf-wasm.wasm 通过 `with { type: "file" }` 让 bun build --compile 把这个 9.6MB 的
// wasm 二进制嵌进单 exe。运行时通过 readFileSync(mupdfWasmPath) 读出字节,塞进 mupdf 暴露
// 的全局 `$libmupdf_wasm_Module.wasmBinary`,这样 mupdf 初始化时不会再尝试按文件路径查找
// wasm —— 而在 compile 后的单 exe 里,那个文件路径根本不存在。
//
// 必须用相对路径(而非 "mupdf/dist/mupdf-wasm.wasm" 这种 package 名前缀): Bun 的
// `with { type: "file" }` 走的是文件路径解析,不走 node module resolution;后者在 compile
// 后的 exe 内会找不到 package。已在 Windows 隔离目录(无 node_modules)实测验证,dev 和
// compile 后的 exe 都能正确加载并提取 PDF。
import mupdfWasmPath from "../node_modules/mupdf/dist/mupdf-wasm.wasm" with { type: "file" };
export let mupdfModule: MupdfModule | null = null;
export let mupdfLoadingPromise: Promise<MupdfModule> | null = null;
export async function loadMupdf(): Promise<MupdfModule> {
  if (mupdfModule) return mupdfModule;
  // 并发的多个 PDF 上传共用同一个 init,避免重复实例化 wasm。
  if (mupdfLoadingPromise) return mupdfLoadingPromise;
  mupdfLoadingPromise = (async () => {
    const wasmBinary = readFileSync(mupdfWasmPath);
    (globalThis as Record<string, unknown>)["$libmupdf_wasm_Module"] = { wasmBinary };
    const mod = await import("mupdf");
    mupdfModule = mod;
    return mod;
  })();
  return mupdfLoadingPromise;
}

export function stripXmlText(input: string) {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function readZipEntries(buffer: Buffer) {
  const entries: Array<{ name: string; data: Buffer }> = [];
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return entries;
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count && offset + 46 <= buffer.length; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8");
    offset += 46 + fileNameLength + extraLength + commentLength;
    if (!name || name.endsWith("/") || localOffset + 30 > buffer.length) continue;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    try {
      if (compression === 0) entries.push({ name, data: raw });
      if (compression === 8) entries.push({ name, data: inflateRawSync(raw) });
    } catch {
      // Ignore unreadable zip members; EPUB text extraction is best-effort.
    }
  }
  return entries;
}

// Extract a single named member from a (potentially huge) zip via an external `unzip` /
// `tar.exe` invocation, so we don't decompress every entry into JS heap just to read one
// XML file. Returns the member's raw bytes or null on failure.
//
// Platform support:
//   - Windows 10+ : System32\tar.exe (BSD libarchive build) speaks zip natively. We
//     spell out the full path to avoid PATH resolving to GNU tar shipped with Git Bash etc.,
//     which only handles tar archives and rejects zip with "This does not look like a tar archive".
//   - Linux: standard `unzip -p <zip> <member>` writes the decompressed bytes to stdout.
//
// Falls back to in-memory readZipEntries if the spawn fails (e.g. missing tool, sandboxed
// environment), so the caller doesn't have to handle that case.
export function extractSingleZipMemberStreaming(zipPath: string, memberName: string): Buffer | null {
  try {
    const isWindows = process.platform === "win32";
    const cmd = isWindows
      ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), "-xOf", zipPath, memberName]
      : ["unzip", "-p", zipPath, memberName];
    const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) {
      const stderr = new TextDecoder().decode(proc.stderr ?? new Uint8Array()).slice(0, 200);
      console.warn(`[document] ${cmd[0]} exit ${proc.exitCode}: ${stderr}`);
      return null;
    }
    const out = proc.stdout;
    if (!out || out.length === 0) return null;
    return Buffer.from(out);
  } catch (err) {
    console.warn(`[document] streaming zip extract spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// --- Document extraction OOM protection ---------------------------------------------------
//
// Android's document module is fully streaming (InputStream.copyTo / ZipFile.getInputStream
// / MuPDF page-by-page), so it doesn't need explicit size caps — single-file memory peak
// stays low even for multi-hundred-MB files. PC end's readFileSync-and-parse approach can't
// match that everywhere without rewriting the zip parser, so we layer in *file-size* guards:
// above these thresholds, extraction is skipped and the prompt falls back to a brief notice
// (see fallbackDocumentText). We do NOT cap extracted-text length — truncating a 6000-line
// upload mid-stream broke large novel/log uploads (Android had no such cap). Models that
// reject oversized prompts will surface the error themselves; that's the user's call.
export const MAX_PDF_EXTRACT_BYTES = 100 * 1024 * 1024;   // 100 MB — MuPDF streams pages, headroom for big books
export const MAX_DOCX_EXTRACT_BYTES = 100 * 1024 * 1024;  // 100 MB — >20 MB routes through streaming unzip, so heap stays bounded
export const MAX_PPTX_EXTRACT_BYTES = 100 * 1024 * 1024;  // 100 MB — PPTX often padded with embedded images
export const MAX_EPUB_EXTRACT_BYTES = 100 * 1024 * 1024;
export const MAX_TEXT_EXTRACT_BYTES = 100 * 1024 * 1024;  // plain text/code; OOM guard only (not a content cap) — covers any realistic novel/log
// DOCX above this size routes to the external-unzip path (`tar.exe` on Windows, `unzip` on
// Linux) to extract only `word/document.xml`, instead of decompressing every zip entry into
// JS heap. Threshold picked at the point where in-memory cost starts to matter.
export const DOCX_STREAMING_THRESHOLD_BYTES = 20 * 1024 * 1024;

// --- Lightweight XML pull parser (mirrors Android XmlPullParser) ----------------
//
// Tokenizes well-formed XML into START_TAG / END_TAG / TEXT events with depth
// tracking. Namespace prefixes are stripped from tag names (e.g. <w:p> → "p")
// to match Android's isNamespaceAware=true behaviour. Not a general-purpose XML
// parser — no entity resolution, no CDATA, no DTD validation — but sufficient
// for the predictable XML inside DOCX / PPTX / EPUB zips.
export const XML_START_TAG = 0;
export const XML_END_TAG = 1;
export const XML_TEXT = 2;
export const XML_EOF = -1;

export function tokenizeXml(xml: string): XmlToken[] {
  const tokens: XmlToken[] = [];
  let depth = 0;
  let i = 0;
  const len = xml.length;
  while (i < len) {
    if (xml[i] === "<") {
      if (xml.startsWith("!--", i + 1)) {
        const end = xml.indexOf("-->", i + 4);
        i = end >= 0 ? end + 3 : len;
        continue;
      }
      if (xml[i + 1] === "?") {
        const end = xml.indexOf("?>", i + 2);
        i = end >= 0 ? end + 2 : len;
        continue;
      }
      if (xml[i + 1] === "/") {
        const end = xml.indexOf(">", i + 2);
        if (end < 0) break;
        let raw = xml.slice(i + 2, end).trim();
        const colon = raw.indexOf(":");
        if (colon >= 0) raw = raw.slice(colon + 1);
        depth--;
        tokens.push({ type: XML_END_TAG, name: raw, depth });
        i = end + 1;
        continue;
      }
      const end = xml.indexOf(">", i + 1);
      if (end < 0) break;
      let tagContent = xml.slice(i + 1, end);
      const selfClose = tagContent.endsWith("/");
      if (selfClose) tagContent = tagContent.slice(0, -1);
      const spaceIdx = tagContent.search(/[\s/]/);
      let rawName = spaceIdx >= 0 ? tagContent.slice(0, spaceIdx).trim() : tagContent.trim();
      const colon = rawName.indexOf(":");
      const localName = colon >= 0 ? rawName.slice(colon + 1) : rawName;
      const attrs: Record<string, string> = {};
      if (spaceIdx >= 0) {
        const attrStr = tagContent.slice(spaceIdx);
        const attrRe = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        let am: RegExpExecArray | null;
        while ((am = attrRe.exec(attrStr)) !== null) {
          attrs[am[1]] = am[2] ?? am[3] ?? "";
        }
      }
      tokens.push({ type: XML_START_TAG, name: localName, attrs, depth });
      if (selfClose) {
        tokens.push({ type: XML_END_TAG, name: localName, depth });
      } else {
        depth++;
      }
      i = end + 1;
    } else {
      let end = xml.indexOf("<", i);
      if (end < 0) end = len;
      const text = xml.slice(i, end);
      if (text.length > 0) {
        tokens.push({ type: XML_TEXT, text, depth });
      }
      i = end;
    }
  }
  return tokens;
}

export class XmlPull {
  private tokens: XmlToken[];
  private pos = 0;
  constructor(xml: string) { this.tokens = tokenizeXml(xml); }
  get eventType() { return this.pos < this.tokens.length ? this.tokens[this.pos].type : XML_EOF; }
  get name() { return this.pos < this.tokens.length ? this.tokens[this.pos].name : undefined; }
  get attrs() { return this.pos < this.tokens.length ? this.tokens[this.pos].attrs : undefined; }
  get text() { return this.pos < this.tokens.length ? this.tokens[this.pos].text : undefined; }
  get depth() { return this.pos < this.tokens.length ? this.tokens[this.pos].depth : -1; }
  next(): number { this.pos++; return this.eventType; }
  getAttributeValue(_ns: string | null, attrName: string): string | null {
    return this.attrs?.[attrName] ?? null;
  }
}

export function getStoredFileSize(entry: StoredFile): number {
  if (typeof entry.size === "number" && entry.size > 0) return entry.size;
  try {
    return statSync(entry.path).size;
  } catch {
    return 0;
  }
}

// EPUB parser — mirrors Android's EpubParser.kt:
// 1. Read META-INF/container.xml → find OPF path
// 2. Parse OPF → extract manifest + spine (chapter reading order)
// 3. Follow spine order, parse each XHTML file with structured text extraction
// Falls back to filename-sorted stripXmlText if container/OPF is missing.
export function extractEpubText(pathValue: string) {
  try {
    const entries = readZipEntries(readFileSync(pathValue));
    const entryMap = new Map(entries.map((e) => [e.name, e]));

    const containerEntry = entryMap.get("META-INF/container.xml");
    if (!containerEntry) return extractEpubFallback(entries);

    const opfPath = findEpubOpfPath(containerEntry.data.toString("utf8"));
    if (!opfPath) return extractEpubFallback(entries);

    const opfEntry = entryMap.get(opfPath);
    if (!opfEntry) return extractEpubFallback(entries);

    const opfDir = opfPath.includes("/") ? opfPath.substring(0, opfPath.lastIndexOf("/")) : "";
    return extractEpubFromOpf(entryMap, opfEntry.data.toString("utf8"), opfDir);
  } catch (err) {
    console.warn("[document] EPUB extract failed:", err);
    return "";
  }
}

export function findEpubOpfPath(containerXml: string): string | null {
  const p = new XmlPull(containerXml);
  while (p.eventType !== XML_EOF) {
    if (p.eventType === XML_START_TAG && p.name === "rootfile") {
      return p.getAttributeValue(null, "full-path");
    }
    p.next();
  }
  return null;
}

export function extractEpubFromOpf(
  entryMap: Map<string, { name: string; data: Buffer }>,
  opfXml: string,
  opfDir: string,
): string {
  const p = new XmlPull(opfXml);
  const manifest = new Map<string, { href: string; mediaType: string }>();
  const spine: string[] = [];
  while (p.eventType !== XML_EOF) {
    if (p.eventType === XML_START_TAG) {
      if (p.name === "item") {
        const id = p.getAttributeValue(null, "id") ?? "";
        const href = p.getAttributeValue(null, "href") ?? "";
        const mediaType = p.getAttributeValue(null, "media-type") ?? "";
        if (id) manifest.set(id, { href, mediaType });
      } else if (p.name === "itemref") {
        const idref = p.getAttributeValue(null, "idref") ?? "";
        if (idref) spine.push(idref);
      }
    }
    p.next();
  }
  const parts: string[] = [];
  for (const itemId of spine) {
    const item = manifest.get(itemId);
    if (!item || !item.mediaType.includes("html")) continue;
    const itemPath = opfDir ? `${opfDir}/${item.href}` : item.href;
    const entry = entryMap.get(itemPath);
    if (!entry) continue;
    const content = parseEpubXhtml(entry.data.toString("utf8"));
    if (content) parts.push(content);
  }
  const text = parts.join("\n\n").trim();
  return text;
}

// Structured XHTML text extraction — mirrors Android's parseXhtml.
// Handles headings, lists (ol/ul/li), bold/italic, blockquotes, images, hr.
export function parseEpubXhtml(xhtml: string): string {
  try {
    const p = new XmlPull(xhtml);
    const result: string[] = [];
    const tagStack: string[] = [];
    let inBody = false;
    let listCounter = 0;
    while (p.eventType !== XML_EOF) {
      if (p.eventType === XML_START_TAG) {
        const tag = p.name ?? "";
        tagStack.push(tag);
        if (tag === "body") inBody = true;
        else if (inBody) {
          if (tag === "ol") { listCounter = 0; }
          else if (tag === "li") {
            const parent = tagStack.length >= 2 ? tagStack[tagStack.length - 2] : "";
            if (parent === "ol") { listCounter++; result.push(`${listCounter}. `); }
            else { result.push("- "); }
          }
          else if (tag === "br") { result.push("\n"); }
          else if (tag === "img") {
            const alt = p.getAttributeValue(null, "alt");
            if (alt) result.push(`[image: ${alt}]`);
          }
          else if (/^h[1-6]$/.test(tag)) { result.push(`${"#".repeat(parseInt(tag[1]))} `); }
          else if (tag === "strong" || tag === "b") { result.push("**"); }
          else if (tag === "em" || tag === "i") { result.push("*"); }
          else if (tag === "hr") { result.push("\n---\n"); }
          else if (tag === "blockquote") { result.push("> "); }
        }
      } else if (p.eventType === XML_TEXT) {
        if (inBody && p.text) {
          const text = p.text.replace(/[\n\r]/g, " ").replace(/\s+/g, " ");
          if (text.trim()) result.push(text);
        }
      } else if (p.eventType === XML_END_TAG) {
        const tag = p.name ?? "";
        if (tagStack.length > 0) tagStack.pop();
        if (tag === "body") inBody = false;
        else if (inBody) {
          if (tag === "p" || tag === "div") { result.push("\n\n"); }
          else if (/^h[1-6]$/.test(tag)) { result.push("\n\n"); }
          else if (tag === "li") { result.push("\n"); }
          else if (tag === "ul" || tag === "ol") { result.push("\n"); }
          else if (tag === "strong" || tag === "b") { result.push("**"); }
          else if (tag === "em" || tag === "i") { result.push("*"); }
          else if (tag === "blockquote") { result.push("\n"); }
        }
      }
      p.next();
    }
    return result.join("").replace(/\n{3,}/g, "\n\n").trim();
  } catch { return ""; }
}

export function extractEpubFallback(entries: Array<{ name: string; data: Buffer }>): string {
  const textEntries = entries
    .filter((e) => /\.(xhtml|html|htm|xml|opf|ncx)$/i.test(e.name))
    .filter((e) => !/^(META-INF\/|mimetype$)/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  return textEntries
    .map((e) => stripXmlText(e.data.toString("utf8")))
    .filter(Boolean)
    .join("\n\n");
}

// Synchronous text extraction for the non-PDF formats. The three on-demand call sites
// (contentPartsForApi / Claude blocks / responses) stay sync and use this to back-fill
// extractedText for legacy entries; PDFs there fall back to a "[Document]" prompt.
export function extractStoredFileTextSync(entry: StoredFile): string {
  const name = entry.fileName.toLowerCase();
  const mimeValue = entry.mime.toLowerCase();
  const size = getStoredFileSize(entry);
  try {
    if (mimeValue === "application/epub+zip" || name.endsWith(".epub")) {
      if (size > MAX_EPUB_EXTRACT_BYTES) {
        console.warn(`[document] skipping EPUB extraction: ${entry.fileName} ${size} > ${MAX_EPUB_EXTRACT_BYTES}`);
        return "";
      }
      return extractEpubText(entry.path);
    }
    if (mimeValue === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || name.endsWith(".docx")) {
      if (size > MAX_DOCX_EXTRACT_BYTES) {
        console.warn(`[document] skipping DOCX extraction: ${entry.fileName} ${size} > ${MAX_DOCX_EXTRACT_BYTES}`);
        return "";
      }
      return extractDocxText(entry.path, size);
    }
    if (mimeValue === "application/vnd.openxmlformats-officedocument.presentationml.presentation" || name.endsWith(".pptx")) {
      if (size > MAX_PPTX_EXTRACT_BYTES) {
        console.warn(`[document] skipping PPTX extraction: ${entry.fileName} ${size} > ${MAX_PPTX_EXTRACT_BYTES}`);
        return "";
      }
      return extractPptxText(entry.path);
    }
    if (
      mimeValue.startsWith("text/") ||
      /\.(txt|md|markdown|csv|tsv|json|jsonl|yaml|yml|xml|html|htm|css|js|ts|tsx|jsx|py|java|kt|rs|go|c|cpp|h|hpp|cs|php|rb|sh|ps1|sql)$/i.test(name)
    ) {
      if (size > MAX_TEXT_EXTRACT_BYTES) {
        // OOM guard: a >100 MB plain-text upload would balloon JS heap. Bail and let
        // fallbackDocumentText tell the model the file is too large to inline. This is a
        // memory ceiling, not content truncation — anything below it flows through in full.
        return "";
      }
      return readFileSync(entry.path, "utf8");
    }
  } catch (err) {
    console.warn(`[document] sync extract failed for ${entry.fileName}:`, err);
  }
  return "";
}

// Full async version, used only by the upload endpoint. Adds PDF handling on top of the
// sync formats. Run once at upload time and cache into entry.extractedText.
export async function extractStoredFileText(entry: StoredFile): Promise<string> {
  const name = entry.fileName.toLowerCase();
  const mimeValue = entry.mime.toLowerCase();
  if (mimeValue === "application/pdf" || name.endsWith(".pdf")) {
    const size = getStoredFileSize(entry);
    if (size > MAX_PDF_EXTRACT_BYTES) {
      console.warn(`[document] skipping PDF extraction: ${entry.fileName} ${size} > ${MAX_PDF_EXTRACT_BYTES}`);
      return "";
    }
    try {
      return await extractPdfText(entry.path);
    } catch (err) {
      console.warn(`[document] PDF extract failed for ${entry.fileName}:`, err);
      return "";
    }
  }
  return extractStoredFileTextSync(entry);
}

// Format a fallback prompt fragment for a document whose text content isn't available —
// either the size cap kicked in, the format isn't extractable here (image-only PDF that
// MuPDF couldn't OCR, exotic mime), or the entry record is gone. The model needs *some*
// signal that the user attached a file, plus a hint about why it can't see the content,
// so it doesn't hallucinate that it read the contents.
export function fallbackDocumentText(part: { fileName: string; url: string; entry: StoredFile | null }): string {
  const { fileName, url, entry } = part;
  if (!entry) {
    return `[Document: ${fileName}] ${url} (file entry missing — user may need to re-upload)`;
  }
  const size = getStoredFileSize(entry);
  const name = entry.fileName.toLowerCase();
  const mimeValue = entry.mime.toLowerCase();
  const sizeMb = (size / (1024 * 1024)).toFixed(1);

  // Size-cap path: tell the model the file is too big to inline so it can ask the user
  // to split / summarize rather than pretend to have read it.
  const overCap =
    ((mimeValue === "application/pdf" || name.endsWith(".pdf")) && size > MAX_PDF_EXTRACT_BYTES) ||
    ((mimeValue === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || name.endsWith(".docx")) && size > MAX_DOCX_EXTRACT_BYTES) ||
    ((mimeValue === "application/vnd.openxmlformats-officedocument.presentationml.presentation" || name.endsWith(".pptx")) && size > MAX_PPTX_EXTRACT_BYTES) ||
    ((mimeValue === "application/epub+zip" || name.endsWith(".epub")) && size > MAX_EPUB_EXTRACT_BYTES) ||
    ((mimeValue.startsWith("text/") || /\.(txt|md|markdown|csv|tsv|json|jsonl|yaml|yml|xml|html|htm|css|js|ts|tsx|jsx|py|java|kt|rs|go|c|cpp|h|hpp|cs|php|rb|sh|ps1|sql)$/i.test(name)) && size > MAX_TEXT_EXTRACT_BYTES);
  if (overCap) {
    return `[Document: ${fileName} — too large to inline (${sizeMb} MB). Ask the user to split it or describe the part they need.]`;
  }
  // Extraction was attempted but came back empty — could be a scanned PDF without OCR-able
  // text, an unsupported binary format, or a parse failure logged at upload time.
  return `[Document: ${fileName} — content could not be extracted; the file may be image-only or use an unsupported format.] ${url}`;
}

// --- Document parsers: aligned with Android's document module ---

// PDF parser — mirrors Android's PdfParser.kt:
//   document = PDFDocument.openDocument(file.absolutePath).asPDF()
//   for i in 0 until pages: page.toStructuredText().asText()
//
// Uses MuPDF WASM (the same engine Android uses as native via JNI). Same API surface,
// same extraction quality —— scanned pages, CID fonts, complex layouts all handled by
// MuPDF's structured-text extractor rather than our previous regex-based approach.
//
// Memory: MuPDF maintains its own wasm heap; we MUST destroy() doc/page/stext explicitly
// because JS GC can't reach into wasm memory. try/finally pairing is non-negotiable.
export async function extractPdfText(pathValue: string): Promise<string> {
  const mupdf = await loadMupdf();
  const buf = readFileSync(pathValue);
  const doc = mupdf.Document.openDocument(buf, "application/pdf");
  try {
    const pageCount = doc.countPages();
    const parts: string[] = [];
    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i);
      try {
        const stext = page.toStructuredText();
        try {
          // Aligned with Android: "---Page ${i+1}:\n${stext.asText()}"
          parts.push(`---Page ${i + 1}:\n${stext.asText()}`);
        } finally {
          stext.destroy?.();
        }
      } finally {
        page.destroy?.();
      }
    }
    return parts.join("\n");
  } finally {
    doc.destroy?.();
  }
}

// DOCX parser — mirrors Android's DocxParser.kt:
// Parse word/document.xml from the ZIP, extract paragraphs with heading/list/table structure.
// For files above DOCX_STREAMING_THRESHOLD_BYTES, route to extractSingleZipMemberStreaming
// (external unzip) so we only spend RAM on the one entry we care about instead of every
// member in the archive.
export function extractDocxText(pathValue: string, sizeBytes?: number) {
  const size = sizeBytes ?? statSync(pathValue).size;
  let docXmlData: Buffer | null = null;
  if (size >= DOCX_STREAMING_THRESHOLD_BYTES) {
    docXmlData = extractSingleZipMemberStreaming(pathValue, "word/document.xml");
    if (!docXmlData) {
      console.warn(`[document] streaming extract failed for ${pathValue}; falling back to in-memory`);
    }
  }
  if (!docXmlData) {
    const entries = readZipEntries(readFileSync(pathValue));
    const docEntry = entries.find((e) => e.name === "word/document.xml");
    if (!docEntry) return "";
    docXmlData = docEntry.data;
  }
  const xml = docXmlData.toString("utf8");
  // Extract body content
  const bodyMatch = xml.match(/<w:body[\s>]?([\s\S]*?)<\/w:body>/i);
  if (!bodyMatch) return stripXmlText(xml);
  const body = bodyMatch[1];
  const result: string[] = [];
  // Walk top-level blocks in document order. We can't naively split on </w:p> because
  // tables contain <w:p> elements inside their cells — match whole <w:tbl>...</w:tbl> and
  // top-level <w:p>...</w:p> blocks instead, scanning left to right.
  const blockRe = /<w:tbl[\s>][\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:p\s*\/>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(body)) !== null) {
    const block = m[0];
    if (/^<w:tbl[\s>]/i.test(block)) {
      const table = extractDocxTable(block);
      if (table) result.push(table);
    } else {
      const text = extractDocxParagraph(block);
      if (text) result.push(text);
    }
  }
  return result.join("\n\n");
}

export function extractDocxParagraph(xml: string): string {
  // Check for heading style
  const pStyleMatch = xml.match(/<w:pStyle[^>]*w:val="([Hh]eading)(\d)"/);
  const headingLevel = pStyleMatch ? parseInt(pStyleMatch[2]) : 0;
  // Check for list/numbering
  const hasNumPr = /<w:numPr[\s>]/i.test(xml);
  const listLevelMatch = xml.match(/<w:ilvl[^>]*w:val="(\d+)"/);
  const listLevel = listLevelMatch ? parseInt(listLevelMatch[1]) : 0;
  const isNumbered = /<w:numId[^>]*w:val="[^0]/i.test(xml);
  // Extract text runs
  const runs: string[] = [];
  const runRe = /<w:r[\s>][\s\S]*?<\/w:r>/gi;
  let runMatch: RegExpExecArray | null;
  while ((runMatch = runRe.exec(xml)) !== null) {
    const runXml = runMatch[0];
    const isBold = /<w:b[\s>/]/i.test(runXml);
    const isItalic = /<w:i[\s>/]/i.test(runXml);
    const tMatch = runXml.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/i);
    if (tMatch) {
      let text = tMatch[1];
      if (isBold && isItalic) text = `***${text}***`;
      else if (isBold) text = `**${text}**`;
      else if (isItalic) text = `*${text}*`;
      runs.push(text);
    }
  }
  const text = runs.join("").trim();
  if (!text) return "";
  if (headingLevel > 0) return `${"#".repeat(headingLevel)} ${text}`;
  if (hasNumPr) {
    const indent = "  ".repeat(listLevel);
    const marker = isNumbered ? "1. " : "- ";
    return `${indent}${marker}${text}`;
  }
  return text;
}

export function extractDocxTable(xml: string): string {
  const rows: string[][] = [];
  const rowRe = /<w:tr[\s>][\s\S]*?<\/w:tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(xml)) !== null) {
    const cells: string[] = [];
    const cellRe = /<w:tc[\s>][\s\S]*?<\/w:tc>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowMatch[0])) !== null) {
      const cellTexts: string[] = [];
      const tRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gi;
      let tMatch: RegExpExecArray | null;
      while ((tMatch = tRe.exec(cellMatch[0])) !== null) {
        cellTexts.push(tMatch[1]);
      }
      cells.push(cellTexts.join(" ").trim());
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return "";
  const maxCols = Math.max(...rows.map((r) => r.length));
  const lines: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const line = "| " + Array.from({ length: maxCols }, (_, ci) => rows[i][ci] ?? "").join(" | ") + " |";
    lines.push(line);
    if (i === 0) lines.push("| " + Array(maxCols).fill("---").join(" | ") + " |");
  }
  return lines.join("\n");
}

// PPTX parser — mirrors Android's PptxParser.kt:
// Process <sp> shapes (with bullet/numbering detection) and <graphicFrame> tables.
// Speaker notes extracted via <ph type="body"> detection (same as Android).
export function extractPptxText(pathValue: string) {
  const entries = readZipEntries(readFileSync(pathValue));
  const entryMap = new Map(entries.map((e) => [e.name, e]));
  const slideEntries = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.name))
    .sort((a, b) => {
      const na = parseInt(a.name.match(/slide(\d+)/i)?.[1] ?? "0");
      const nb = parseInt(b.name.match(/slide(\d+)/i)?.[1] ?? "0");
      return na - nb;
    });
  if (!slideEntries.length) return "";
  const slides: string[] = [];
  for (let i = 0; i < slideEntries.length; i++) {
    const slideNumber = i + 1;
    const content = parsePptxSlideXml(slideEntries[i].data.toString("utf8"));
    const notesEntry = entryMap.get(`ppt/notesSlides/notesSlide${slideNumber}.xml`);
    const notes = notesEntry ? parsePptxNotesXml(notesEntry.data.toString("utf8")) : "";
    if (!content && !notes) continue;
    let slide = `## Slide ${slideNumber}\n\n${content}`;
    if (notes) slide += `\n\n### Speaker Notes\n\n${notes}`;
    slides.push(slide);
  }
  return slides.join("\n\n");
}

export function parsePptxSlideXml(xml: string): string {
  try {
    const p = new XmlPull(xml);
    const result: string[] = [];
    while (p.eventType !== XML_EOF) {
      if (p.eventType === XML_START_TAG) {
        if (p.name === "sp") processPptxShape(p, result);
        else if (p.name === "graphicFrame") processPptxGraphicFrame(p, result);
      }
      p.next();
    }
    return result.join("");
  } catch { return ""; }
}

export function processPptxShape(p: XmlPull, result: string[]) {
  const startDepth = p.depth;
  const textParts: string[] = [];
  while (p.next() !== XML_EOF) {
    if (p.eventType === XML_START_TAG && p.name === "p") processPptxParagraph(p, textParts);
    if (p.eventType === XML_END_TAG && p.name === "sp" && p.depth === startDepth) break;
  }
  const text = textParts.join("").trim();
  if (text) { result.push(text); result.push("\n\n"); }
}

export function processPptxParagraph(p: XmlPull, result: string[]) {
  const startDepth = p.depth;
  const runTexts: string[] = [];
  let hasBullet = false, bulletLevel = 0, isNumbered = false;
  while (p.next() !== XML_EOF) {
    if (p.eventType === XML_START_TAG) {
      if (p.name === "pPr") {
        const info = extractPptxBulletInfo(p);
        hasBullet = info.hasBullet; bulletLevel = info.level; isNumbered = info.isNumbered;
      }
      if (p.name === "r") extractPptxTextRun(p, runTexts);
    }
    if (p.eventType === XML_END_TAG && p.name === "p" && p.depth === startDepth) break;
  }
  const text = runTexts.join("").trim();
  if (!text) return;
  if (hasBullet) {
    const indent = "  ".repeat(bulletLevel);
    result.push(`${indent}${isNumbered ? "1. " : "- "}${text}\n`);
  } else {
    result.push(`${text}\n`);
  }
}

export function extractPptxBulletInfo(p: XmlPull): { hasBullet: boolean; level: number; isNumbered: boolean } {
  const startDepth = p.depth;
  let hasBullet = false, level = 0, isNumbered = false;
  while (p.next() !== XML_EOF) {
    if (p.eventType === XML_START_TAG) {
      if (p.name === "buChar") { hasBullet = true; isNumbered = false; }
      if (p.name === "buAutoNum") { hasBullet = true; isNumbered = true; }
      if (p.name === "lvl") { const v = p.getAttributeValue(null, "val"); if (v) level = parseInt(v) || 0; }
    }
    if (p.eventType === XML_END_TAG && p.name === "pPr" && p.depth === startDepth) break;
  }
  return { hasBullet, level, isNumbered };
}

export function extractPptxTextRun(p: XmlPull, result: string[]) {
  const startDepth = p.depth;
  while (p.next() !== XML_EOF) {
    const ev = p.eventType;
    if (ev === XML_START_TAG && p.name === "t") {
      p.next();
      if (p.eventType === XML_TEXT && p.text) result.push(p.text);
    }
    if (ev === XML_END_TAG && p.name === "r" && p.depth === startDepth) break;
  }
}

export function processPptxGraphicFrame(p: XmlPull, result: string[]) {
  const startDepth = p.depth;
  while (p.next() !== XML_EOF) {
    const ev = p.eventType;
    if (ev === XML_START_TAG && p.name === "tbl") processPptxTable(p, result);
    if (ev === XML_END_TAG && p.name === "graphicFrame" && p.depth === startDepth) break;
  }
}

export function processPptxTable(p: XmlPull, result: string[]) {
  const startDepth = p.depth;
  const rows: string[][] = [];
  while (p.next() !== XML_EOF) {
    const ev = p.eventType;
    if (ev === XML_START_TAG && p.name === "tr") {
      const cells = extractPptxTableRow(p);
      if (cells.length) rows.push(cells);
    }
    if (ev === XML_END_TAG && p.name === "tbl" && p.depth === startDepth) break;
  }
  if (!rows.length) return;
  const maxCols = Math.max(...rows.map((r) => r.length));
  for (let i = 0; i < rows.length; i++) {
    result.push("| " + Array.from({ length: maxCols }, (_, ci) => rows[i][ci] ?? "").join(" | ") + " |\n");
    if (i === 0) result.push("| " + Array(maxCols).fill("---").join(" | ") + " |\n");
  }
  result.push("\n");
}

export function extractPptxTableRow(p: XmlPull): string[] {
  const startDepth = p.depth;
  const cells: string[] = [];
  while (p.next() !== XML_EOF) {
    if (p.eventType === XML_START_TAG && p.name === "tc") cells.push(extractPptxTableCell(p));
    if (p.eventType === XML_END_TAG && p.name === "tr" && p.depth === startDepth) break;
  }
  return cells;
}

export function extractPptxTableCell(p: XmlPull): string {
  const startDepth = p.depth;
  const parts: string[] = [];
  while (p.next() !== XML_EOF) {
    const ev = p.eventType;
    if (ev === XML_START_TAG && p.name === "t") {
      p.next();
      if (p.eventType === XML_TEXT && p.text) {
        if (parts.length > 0) parts.push(" ");
        parts.push(p.text);
      }
    }
    if (ev === XML_END_TAG && p.name === "tc" && p.depth === startDepth) break;
  }
  return parts.join("").trim();
}

export function parsePptxNotesXml(xml: string): string {
  try {
    const p = new XmlPull(xml);
    const result: string[] = [];
    while (p.eventType !== XML_EOF) {
      if (p.eventType === XML_START_TAG && p.name === "sp") {
        if (isPptxNotesTextShape(p)) extractPptxShapeText(p, result);
      }
      p.next();
    }
    return result.join("").trim();
  } catch { return ""; }
}

// Look ahead inside <sp> for <ph type="body"> — marks the notes text area (not the slide preview).
export function isPptxNotesTextShape(p: XmlPull): boolean {
  const d = p.depth;
  while (p.next() !== XML_EOF) {
    if (p.eventType === XML_START_TAG && p.name === "ph") return p.getAttributeValue(null, "type") === "body";
    if (p.eventType === XML_END_TAG && p.depth <= d) return false;
  }
  return false;
}

export function extractPptxShapeText(p: XmlPull, result: string[]) {
  while (p.next() !== XML_EOF) {
    const ev = p.eventType;
    if (ev === XML_START_TAG && p.name === "t") {
      p.next();
      if (p.eventType === XML_TEXT && p.text) result.push(p.text);
    }
    if (ev === XML_END_TAG && p.name === "p") result.push("\n");
  }
}

export function safeDataFilePath(relativePath: string) {
  let decoded = "";
  try {
    decoded = decodeURIComponent(relativePath).replace(/\\/g, "/").replace(/^\/+/, "");
  } catch {
    return null;
  }
  if (!decoded || decoded.split("/").some((part) => part === "..")) return null;
  const roots = [resolve(dataDir), resolve(filesDir)];
  const separator = process.platform === "win32" ? "\\" : "/";
  const candidates = [resolve(dataDir, decoded), resolve(filesDir, decoded)];
  return candidates.find((candidate) =>
    roots.some((root) => (candidate === root || candidate.startsWith(`${root}${separator}`))) &&
    existsSync(candidate) &&
    statSync(candidate).isFile()
  ) ?? null;
}
