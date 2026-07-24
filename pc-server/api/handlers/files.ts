// api/handlers/files.ts — 文件路由（files/upload、content、path、delete）
// 纪律：纯搬迁自 server.ts routeApi()。

import { existsSync } from "node:fs";
import { safeDataFilePath } from "../../files";
import { extname, join } from "node:path";
import type { StoredFile } from "../../foundation/types";
import { filesDir } from "../../foundation/paths";
import { saveState, state } from "../../persistence/json-store";
import { extractStoredFileText } from "../../files/index";
import { error, json, mime } from "../request";

export async function handleFileRoutes(request: Request, _url: URL, path: string): Promise<Response | null> {
  if (path === "files/upload" && request.method === "POST") {
    const form = await request.formData();
    const uploaded = await Promise.all(
      form.getAll("files").filter((item): item is File => item instanceof File).map(async (file) => {
        const fileId = state.nextFileId++;
        const target = join(filesDir, `${fileId}${extname(file.name)}`);
        await Bun.write(target, file);
        const entry: StoredFile = { id: fileId, path: target, fileName: file.name, mime: file.type || "application/octet-stream", size: file.size };
        const t0 = Date.now();
        const extractedText = await extractStoredFileText(entry);
        if (extractedText) {
          entry.extractedText = extractedText;
          entry.extractedAt = Date.now();
        }
        console.log(`[upload] ${entry.fileName} (${(file.size / 1024).toFixed(1)} KB) extracted ${extractedText.length} chars in ${Date.now() - t0}ms`);
        state.files.push(entry);
        return {
          id: fileId,
          url: `/api/files/${fileId}/content`,
          fileName: entry.fileName,
          mime: entry.mime,
          size: entry.size,
          extractedTextLength: entry.extractedText?.length ?? 0,
        };
      }),
    );
    saveState();
    return json({ files: uploaded });
  }
  const fileContent = path.match(/^files\/(\d+)\/content$/);
  if (fileContent) {
    const entry = state.files.find((item) => item.id === Number(fileContent[1]));
    if (!entry || !existsSync(entry.path)) return error("File not found", 404);
    // File IDs are integer primary keys assigned at upload time; content for a given id
    // never changes (upload is write-once). The `immutable` directive tells the browser
    // never to revalidate this URL, so switching back to a previously-viewed conversation
    // hits the in-memory cache instantly instead of round-tripping to localhost.
    // Without this, the browser used heuristic caching (effectively none for /api/...
    // paths) and the user saw every image re-load on every conversation switch — even
    // ones they'd viewed seconds earlier. The ETag is a belt-and-suspenders fallback for
    // browsers that disregard `immutable`.
    return new Response(Bun.file(entry.path), {
      headers: {
        "Content-Type": entry.mime,
        "Cache-Control": "public, max-age=31536000, immutable",
        "ETag": `"${entry.id}"`,
      },
    });
  }
  const fileByPath = path.match(/^files\/path\/(.+)$/);
  if (fileByPath) {
    const target = safeDataFilePath(fileByPath[1]);
    if (!target) return error("File not found", 404);
    // Same caching rationale as the by-id endpoint above. Path-based fetches typically
    // come from Android-imported messages whose URL references survived migration —
    // those resolved paths point to immutable on-disk files.
    return new Response(Bun.file(target), {
      headers: {
        "Content-Type": mime(target),
        "Cache-Control": "public, max-age=31536000, immutable",
        "ETag": `"path:${fileByPath[1]}"`,
      },
    });
  }
  const fileDelete = path.match(/^files\/(\d+)$/);
  if (fileDelete && request.method === "DELETE") {
    state.files = state.files.filter((item) => item.id !== Number(fileDelete[1]));
    saveState();
    return json({ status: "deleted" });
  }
  return null;
}
