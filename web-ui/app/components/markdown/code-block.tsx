import * as React from "react";
import type { ComponentProps, CSSProperties, HTMLAttributes } from "react";

import { Check, Code2, Copy, Download, Eye } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  bundledLanguages,
  createHighlighter,
  type BundledLanguage,
  type BundledTheme,
  type HighlighterGeneric,
  type ThemedToken,
} from "shiki";

import { getCodePreviewLanguage } from "~/components/workbench/code-preview-language";
import {
  createStreamingTokenizer,
  type StreamingTokenizer,
  type TokenizedCode,
} from "./incremental-shiki";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { copyTextToClipboard } from "~/lib/clipboard";
import { cn } from "~/lib/utils";

const MAX_SHIKI_CODE_LENGTH = 12000;
const SHIKI_CACHE_LIMIT = 200;
const SHIKI_THEME_LIGHT = "catppuccin-latte";
const SHIKI_THEME_DARK = "catppuccin-mocha";

interface KeyedToken {
  key: string;
  token: ThemedToken;
}

interface KeyedLine {
  key: string;
  tokens: KeyedToken[];
}

type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: string;
  onPreview?: () => void;
  showLineNumbers?: boolean;
  wrapLines?: boolean;
};

interface CodeBlockContextType {
  code: string;
  language: string;
}

const ITALIC_STYLES = new Set([1, 3, 5, 7]);
const BOLD_STYLES = new Set([2, 3, 6, 7]);
const UNDERLINE_STYLES = new Set([4, 5, 6, 7]);

const CodeBlockContext = React.createContext<CodeBlockContextType>({
  code: "",
  language: "text",
});

const DEFAULT_DOWNLOAD_FILE_NAME = "code.txt";
const CODE_LANGUAGE_EXTENSION_MAP: Record<string, string> = {
  bash: "sh",
  csharp: "cs",
  javascript: "js",
  js: "js",
  jsx: "jsx",
  kotlin: "kt",
  markdown: "md",
  plaintext: "txt",
  python: "py",
  shell: "sh",
  typescript: "ts",
  tsx: "tsx",
};

function buildInlinePreviewDocument(code: string, language: string): string {
  if (language === "svg") {
    return `<!doctype html><html><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /></head><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:white;">${code}</body></html>`;
  }
  return code;
}

function toDownloadFileName(language: string): string {
  const normalized = language.trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_DOWNLOAD_FILE_NAME;
  }

  const mappedExtension = CODE_LANGUAGE_EXTENSION_MAP[normalized];
  if (mappedExtension) {
    return `code.${mappedExtension}`;
  }

  const safeExtension = normalized.replace(/[^a-z0-9]+/g, "");
  if (!safeExtension) {
    return DEFAULT_DOWNLOAD_FILE_NAME;
  }

  return `code.${safeExtension}`;
}

const highlighterCache = new Map<
  BundledLanguage,
  Promise<HighlighterGeneric<BundledLanguage, BundledTheme>>
>();
const resolvedHighlighters = new Map<
  BundledLanguage,
  HighlighterGeneric<BundledLanguage, BundledTheme>
>();
const tokensCache = new Map<string, TokenizedCode>();
const subscribers = new Map<string, Set<(result: TokenizedCode) => void>>();

function resolveShikiLanguage(language: string): BundledLanguage | null {
  const normalized = language.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (!Object.prototype.hasOwnProperty.call(bundledLanguages, normalized)) {
    return null;
  }

  return normalized as BundledLanguage;
}

function getTokensCacheKey(code: string, language: BundledLanguage): string {
  return `${language}\u0000${code}`;
}

function readTokensFromCache(cacheKey: string): TokenizedCode | null {
  const cached = tokensCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  tokensCache.delete(cacheKey);
  tokensCache.set(cacheKey, cached);
  return cached;
}

function writeTokensToCache(cacheKey: string, tokenized: TokenizedCode): void {
  if (tokensCache.size >= SHIKI_CACHE_LIMIT) {
    const oldest = tokensCache.keys().next().value;
    if (typeof oldest === "string") {
      tokensCache.delete(oldest);
    }
  }

  tokensCache.set(cacheKey, tokenized);
}

// 空闲期高亮调度:打开会话时若干代码块同帧挂载,同步全量分词会把 ~15-40ms/块的
// Shiki(oniguruma wasm)串成一个数百毫秒的主线程长任务,压在首开关键路径上
// (性能探针实测 ~180-230ms)。改为空闲期逐块执行:一个空闲片只处理一个代码块,
// 高亮完成前按原文渲染(行数/等宽字体不变 → 高度不变,无布局跳动)。
const pendingHighlightJobs: Array<() => void> = [];
let highlightDrainScheduled = false;

function drainOneHighlightJob(): void {
  const job = pendingHighlightJobs.shift();
  // B1(专题1/2复查):job 抛错也必须重调度/复位,否则 highlightDrainScheduled 永久卡 true,
  // 后续所有代码块只入队不消费,全局高亮静默失效。单个坏任务不得拖垮队列。
  try {
    job?.();
  } finally {
    if (pendingHighlightJobs.length > 0) {
      scheduleHighlightDrain();
    } else {
      highlightDrainScheduled = false;
    }
  }
}

function scheduleHighlightDrain(): void {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(drainOneHighlightJob, { timeout: 200 });
  } else {
    window.setTimeout(drainOneHighlightJob, 16);
  }
}

function scheduleIdleHighlight(job: () => void): void {
  pendingHighlightJobs.push(job);
  if (highlightDrainScheduled) return;
  highlightDrainScheduled = true;
  scheduleHighlightDrain();
}

function getHighlighter(
  language: BundledLanguage,
): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> {
  const cached = highlighterCache.get(language);
  if (cached) {
    return cached;
  }

  const highlighterPromise = createHighlighter({
    langs: [language],
    themes: [SHIKI_THEME_LIGHT, SHIKI_THEME_DARK],
  });
  highlighterCache.set(language, highlighterPromise);
  return highlighterPromise;
}

function createRawTokens(code: string): TokenizedCode {
  return {
    bg: "transparent",
    fg: "inherit",
    tokens: code.split("\n").map((line) =>
      line === ""
        ? []
        : [
            {
              color: "inherit",
              content: line,
            } as ThemedToken,
          ],
    ),
  };
}

function addKeysToTokens(lines: ThemedToken[][]): KeyedLine[] {
  return lines.map((line, lineIndex) => ({
    key: `line-${lineIndex}`,
    tokens: line.map((token, tokenIndex) => ({
      key: `line-${lineIndex}-${tokenIndex}`,
      token,
    })),
  }));
}

function isItalic(fontStyle: number | undefined): boolean {
  return ITALIC_STYLES.has(fontStyle ?? 0);
}

function isBold(fontStyle: number | undefined): boolean {
  return BOLD_STYLES.has(fontStyle ?? 0);
}

function isUnderline(fontStyle: number | undefined): boolean {
  return UNDERLINE_STYLES.has(fontStyle ?? 0);
}

function highlightCode(
  code: string,
  language: BundledLanguage,
  callback?: (result: TokenizedCode) => void,
): TokenizedCode | null {
  const tokensCacheKey = getTokensCacheKey(code, language);
  const cached = readTokensFromCache(tokensCacheKey);
  if (cached) {
    return cached;
  }

  // Synchronous path: if the highlighter is already loaded, highlight immediately
  const resolved = resolvedHighlighters.get(language);
  if (resolved) {
    const tokenResult = resolved.codeToTokens(code, {
      lang: language,
      themes: {
        light: SHIKI_THEME_LIGHT,
        dark: SHIKI_THEME_DARK,
      },
    });

    const tokenized: TokenizedCode = {
      bg: tokenResult.bg ?? "transparent",
      fg: tokenResult.fg ?? "inherit",
      tokens: tokenResult.tokens,
    };

    writeTokensToCache(tokensCacheKey, tokenized);
    return tokenized;
  }

  // Async path: first time loading this language's highlighter
  if (callback) {
    if (!subscribers.has(tokensCacheKey)) {
      subscribers.set(tokensCacheKey, new Set());
    }
    subscribers.get(tokensCacheKey)?.add(callback);
  }

  void getHighlighter(language)
    .then((highlighter) => {
      resolvedHighlighters.set(language, highlighter);

      // 装载完成后的分词同样进空闲队列:多个代码块等同一高亮器时,promise 回调
      // 会在同一次微任务清空里连续执行,等于把 N 次分词又串成一个长任务。
      // 空闲片内先查缓存(同内容多次订阅只分词一次)。
      scheduleIdleHighlight(() => {
        const tokenized =
          readTokensFromCache(tokensCacheKey) ??
          (() => {
            const tokenResult = highlighter.codeToTokens(code, {
              lang: language,
              themes: {
                light: SHIKI_THEME_LIGHT,
                dark: SHIKI_THEME_DARK,
              },
            });
            const fresh: TokenizedCode = {
              bg: tokenResult.bg ?? "transparent",
              fg: tokenResult.fg ?? "inherit",
              tokens: tokenResult.tokens,
            };
            writeTokensToCache(tokensCacheKey, fresh);
            return fresh;
          })();
        const subs = subscribers.get(tokensCacheKey);
        if (subs) {
          for (const sub of subs) {
            sub(tokenized);
          }
          subscribers.delete(tokensCacheKey);
        }
      });
    })
    .catch(() => {
      const fallback = createRawTokens(code);
      writeTokensToCache(tokensCacheKey, fallback);
      const subs = subscribers.get(tokensCacheKey);
      if (subs) {
        for (const sub of subs) {
          sub(fallback);
        }
        subscribers.delete(tokensCacheKey);
      }
    });

  return null;
}

const LINE_NUMBER_CLASSES = cn(
  "block",
  "before:mr-4",
  "before:inline-block",
  "before:w-8",
  "before:text-right",
  "before:font-mono",
  "before:text-muted-foreground/50",
  "before:select-none",
  "before:content-[counter(line)]",
  "before:[counter-increment:line]",
);

function TokenSpan({ token }: { token: ThemedToken }) {
  return (
    <span
      className="dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)]"
      style={
        {
          backgroundColor: token.bgColor,
          color: token.color,
          fontStyle: isItalic(token.fontStyle) ? "italic" : undefined,
          fontWeight: isBold(token.fontStyle) ? "bold" : undefined,
          textDecoration: isUnderline(token.fontStyle) ? "underline" : undefined,
          ...token.htmlStyle,
        } as CSSProperties
      }
    >
      {token.content}
    </span>
  );
}

function LineSpan({
  keyedLine,
  showLineNumbers,
}: {
  keyedLine: KeyedLine;
  showLineNumbers: boolean;
}) {
  return (
    <span className={showLineNumbers ? LINE_NUMBER_CLASSES : "block"}>
      {keyedLine.tokens.length === 0
        ? "\n"
        : keyedLine.tokens.map(({ key, token }) => <TokenSpan key={key} token={token} />)}
    </span>
  );
}

const CodeBlockBody = React.memo(
  ({
    className,
    showLineNumbers,
    tokenized,
    wrapLines,
  }: {
    className?: string;
    showLineNumbers: boolean;
    tokenized: TokenizedCode;
    wrapLines: boolean;
  }) => {
    const preStyle = React.useMemo(
      () => ({
        backgroundColor: tokenized.bg,
        color: tokenized.fg,
      }),
      [tokenized.bg, tokenized.fg],
    );

    const keyedLines = React.useMemo(() => addKeysToTokens(tokenized.tokens), [tokenized.tokens]);

    return (
      <pre
        className={cn(
          "m-0 p-3 text-sm",
          wrapLines ? "whitespace-pre-wrap" : "whitespace-pre",
          className,
        )}
        style={preStyle}
      >
        <code
          className={cn(
            "font-mono leading-relaxed",
            showLineNumbers && "[counter-increment:line_0] [counter-reset:line]",
          )}
        >
          {keyedLines.map((keyedLine) => (
            <LineSpan key={keyedLine.key} keyedLine={keyedLine} showLineNumbers={showLineNumbers} />
          ))}
        </code>
      </pre>
    );
  },
  (prevProps, nextProps) =>
    prevProps.className === nextProps.className &&
    prevProps.showLineNumbers === nextProps.showLineNumbers &&
    prevProps.wrapLines === nextProps.wrapLines &&
    prevProps.tokenized === nextProps.tokenized,
);

CodeBlockBody.displayName = "CodeBlockBody";

export function CodeBlockContainer({
  className,
  language,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & { language: string }) {
  return (
    <div
      className={cn(
        "code-block group relative w-full overflow-hidden rounded-lg border border-border",
        className,
      )}
      data-language={language}
      style={style}
      {...props}
    />
  );
}

export function CodeBlockHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("code-block-header", className)} {...props} />;
}

export function CodeBlockTitle({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center gap-2", className)} {...props} />;
}

export function CodeBlockLanguage({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("code-block-language", className)} {...props} />;
}

export function CodeBlockActions({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("code-block-actions", className)} {...props} />;
}

export function CodeBlockContent({
  code,
  language,
  showLineNumbers = false,
  wrapLines = false,
}: {
  code: string;
  language: BundledLanguage | null;
  showLineNumbers?: boolean;
  wrapLines?: boolean;
}) {
  const rawTokens = React.useMemo(() => createRawTokens(code), [code]);
  const shouldHighlight = Boolean(language) && code.length <= MAX_SHIKI_CODE_LENGTH;

  // H-a(专题2):行级增量分词器,组件实例级。流式中的代码块每帧增长,全文缓存键
  // (lang+全文)永不命中,旧路径等于每帧全量重分词(12KB tsx 实测 ~40ms,单高亮一项
  // 超掉 33ms 帧预算)。增量器只重算未完成的尾行(实测 ~0.02ms),已完成行只分词一次。
  const tokenizerRef = React.useRef<{
    language: BundledLanguage;
    tokenizer: StreamingTokenizer;
  } | null>(null);
  const lastResultRef = React.useRef<{ cacheKey: string; result: TokenizedCode } | null>(null);

  // 同步高亮入口:全文缓存 → 增量分词器 → null(该语言高亮器尚未装载,走异步订阅)。
  const highlightSync = React.useCallback(
    (codeText: string, lang: BundledLanguage): TokenizedCode | null => {
      const cacheKey = getTokensCacheKey(codeText, lang);
      const cached = readTokensFromCache(cacheKey);
      if (cached) {
        // 命中全文缓存(静态块/Virtuoso 重挂载):无需增量器,也无需卸载时回写。
        tokenizerRef.current = null;
        lastResultRef.current = null;
        return cached;
      }
      const resolved = resolvedHighlighters.get(lang);
      if (!resolved) return null;
      let entry = tokenizerRef.current;
      if (!entry || entry.language !== lang) {
        entry = {
          language: lang,
          tokenizer: createStreamingTokenizer(resolved, lang, {
            light: SHIKI_THEME_LIGHT,
            dark: SHIKI_THEME_DARK,
          }),
        };
        tokenizerRef.current = entry;
      }
      const { result, wasFullTokenize } = entry.tokenizer.tokenize(codeText);
      // 只在"从零全量"时写全文缓存(静态块行为与旧实现一致)。增量帧不写——旧实现
      // 每帧写一条中间态条目,一次流式就把 200 条缓存全部挤掉(缓存污染)。
      if (wasFullTokenize) writeTokensToCache(cacheKey, result);
      lastResultRef.current = { cacheKey, result };
      return result;
    },
    [],
  );

  const [tokenized, setTokenized] = React.useState<TokenizedCode>(() => {
    if (!shouldHighlight || !language) {
      return rawTokens;
    }

    // 挂载首帧只读全文缓存(切回会话零闪烁);cache miss 不同步分词——由下方
    // effect 的空闲期调度完成,避免打开会话时多个代码块同帧串成长任务。
    return readTokensFromCache(getTokensCacheKey(code, language)) ?? rawTokens;
  });

  React.useEffect(() => {
    if (!shouldHighlight || !language) {
      setTokenized(rawTokens);
      return;
    }

    // 流式增量路径:实例级分词器已存在(该块正在逐帧增长),同步只重算尾行,
    // 逐帧高亮语义不变。
    if (tokenizerRef.current?.language === language) {
      const sync = highlightSync(code, language);
      if (sync) {
        setTokenized(sync);
        return;
      }
    } else {
      const cached = readTokensFromCache(getTokensCacheKey(code, language));
      if (cached) {
        tokenizerRef.current = null;
        lastResultRef.current = null;
        setTokenized(cached);
        return;
      }
    }

    // cache miss:分词推迟到空闲期。高亮器已装载则空闲片内同步分词;尚未装载
    // 沿用订阅机制(装载完成回调 setState)。期间按原文渲染,高度不变。
    let cancelled = false;
    const tokensCacheKey = getTokensCacheKey(code, language);
    const onHighlighted = (result: TokenizedCode) => {
      if (!cancelled) {
        setTokenized(result);
      }
    };

    scheduleIdleHighlight(() => {
      if (cancelled) return;
      const sync = highlightSync(code, language);
      if (sync) {
        setTokenized(sync);
        return;
      }
      const nextTokenized = highlightCode(code, language, onHighlighted);
      if (nextTokenized) {
        setTokenized(nextTokenized);
      }
      // null = 高亮器装载中,订阅回调兜底。
    });

    return () => {
      cancelled = true;
      const subs = subscribers.get(tokensCacheKey);
      subs?.delete(onHighlighted);
      if (subs && subs.size === 0) {
        subscribers.delete(tokensCacheKey);
      }
    };
  }, [code, language, rawTokens, shouldHighlight, highlightSync]);

  // 卸载时把最终 token 写回全文缓存:Virtuoso 滚动导致的卸载/重挂载零成本恢复高亮。
  React.useEffect(
    () => () => {
      const last = lastResultRef.current;
      if (last && tokenizerRef.current) {
        writeTokensToCache(last.cacheKey, last.result);
      }
    },
    [],
  );

  return (
    <div
      className={cn(
        "code-block-content relative",
        wrapLines ? "overflow-y-auto overflow-x-hidden" : "overflow-auto",
      )}
    >
      <CodeBlockBody
        className="dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)]"
        showLineNumbers={showLineNumbers}
        tokenized={tokenized}
        wrapLines={wrapLines}
      />
    </div>
  );
}

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
};

export function CodeBlockCopyButton({
  children,
  className,
  onCopy,
  onError,
  timeout = 2000,
  ...props
}: CodeBlockCopyButtonProps) {
  const { t } = useTranslation("markdown");
  const [isCopied, setIsCopied] = React.useState(false);
  const timeoutRef = React.useRef<number>(0);
  const { code } = React.useContext(CodeBlockContext);

  const copyToClipboard = React.useCallback(async () => {
    if (isCopied) {
      return;
    }

    try {
      await copyTextToClipboard(code);
      setIsCopied(true);
      onCopy?.();
      timeoutRef.current = window.setTimeout(() => {
        setIsCopied(false);
      }, timeout);
    } catch (error) {
      onError?.(error as Error);
    }
  }, [code, isCopied, onCopy, onError, timeout]);

  React.useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current);
    },
    [],
  );

  return (
    <Button
      aria-label={t("code_block.copy_code")}
      className={cn("code-block-copy h-6 px-1.5", className)}
      onClick={copyToClipboard}
      size="xs"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ??
        (isCopied ? (
          <>
            <Check className="size-3" />
            <span>{t("code_block.copied")}</span>
          </>
        ) : (
          <>
            <Copy className="size-3" />
            <span>{t("code_block.copy")}</span>
          </>
        ))}
    </Button>
  );
}

export type CodeBlockPreviewButtonProps = Omit<ComponentProps<typeof Button>, "onClick"> & {
  onPreview: () => void;
  active?: boolean;
};

export function CodeBlockPreviewButton({
  active,
  children,
  className,
  onPreview,
  ...props
}: CodeBlockPreviewButtonProps) {
  const { t } = useTranslation("markdown");
  return (
    <Button
      aria-label={t("code_block.preview_code")}
      className={cn("code-block-copy h-6 px-1.5", className)}
      onClick={onPreview}
      size="xs"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? (
        <>
          {active ? <Code2 className="size-3" /> : <Eye className="size-3" />}
          <span>{active ? t("code_block.source") : t("code_block.preview")}</span>
        </>
      )}
    </Button>
  );
}

export type CodeBlockDownloadButtonProps = ComponentProps<typeof Button> & {
  onDownload?: () => void;
  onError?: (error: Error) => void;
};

export function CodeBlockDownloadButton({
  children,
  className,
  onDownload,
  onError,
  timeout = 2000,
  ...props
}: CodeBlockDownloadButtonProps & { timeout?: number }) {
  const { t } = useTranslation("markdown");
  const { code, language } = React.useContext(CodeBlockContext);
  const [isDownloaded, setIsDownloaded] = React.useState(false);
  const timeoutRef = React.useRef<number>(0);

  const handleDownload = React.useCallback(() => {
    if (isDownloaded) return;

    if (typeof window === "undefined") {
      onError?.(new Error(t("code_block.window_not_available")));
      return;
    }

    try {
      const fileName = toDownloadFileName(language);
      const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.append(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      setIsDownloaded(true);
      onDownload?.();
      timeoutRef.current = window.setTimeout(() => {
        setIsDownloaded(false);
      }, timeout);
      toast.success(t("code_block.downloaded_toast", { name: fileName }), {
        duration: 5000,
      });
    } catch (error) {
      onError?.(error as Error);
    }
  }, [code, isDownloaded, language, onDownload, onError, t, timeout]);

  React.useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current);
    },
    [],
  );

  return (
    <Button
      aria-label={t("code_block.download_code")}
      className={cn("code-block-copy h-6 px-1.5", className)}
      onClick={handleDownload}
      size="xs"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ??
        (isDownloaded ? (
          <>
            <Check className="size-3" />
            <span>{t("code_block.downloaded")}</span>
          </>
        ) : (
          <>
            <Download className="size-3" />
            <span>{t("code_block.download")}</span>
          </>
        ))}
    </Button>
  );
}

export type CodeBlockLanguageSelectorProps = ComponentProps<typeof Select>;

export function CodeBlockLanguageSelector(props: CodeBlockLanguageSelectorProps) {
  return <Select {...props} />;
}

export type CodeBlockLanguageSelectorTriggerProps = ComponentProps<typeof SelectTrigger>;

export function CodeBlockLanguageSelectorTrigger({
  className,
  ...props
}: CodeBlockLanguageSelectorTriggerProps) {
  return (
    <SelectTrigger
      className={cn("h-7 border-none bg-transparent px-2 text-xs shadow-none", className)}
      size="sm"
      {...props}
    />
  );
}

export type CodeBlockLanguageSelectorValueProps = ComponentProps<typeof SelectValue>;

export function CodeBlockLanguageSelectorValue(props: CodeBlockLanguageSelectorValueProps) {
  return <SelectValue {...props} />;
}

export type CodeBlockLanguageSelectorContentProps = ComponentProps<typeof SelectContent>;

export function CodeBlockLanguageSelectorContent({
  align = "end",
  ...props
}: CodeBlockLanguageSelectorContentProps) {
  return <SelectContent align={align} {...props} />;
}

export type CodeBlockLanguageSelectorItemProps = ComponentProps<typeof SelectItem>;

export function CodeBlockLanguageSelectorItem(props: CodeBlockLanguageSelectorItemProps) {
  return <SelectItem {...props} />;
}

export function CodeBlock({
  className,
  code,
  language,
  onPreview,
  showLineNumbers = false,
  wrapLines = false,
  ...props
}: CodeBlockProps) {
  const displayLanguage = language || "text";
  const previewLanguage = React.useMemo(() => getCodePreviewLanguage(language), [language]);
  const canPreview = Boolean(onPreview && previewLanguage);
  const canInlinePreview = previewLanguage === "html" || previewLanguage === "svg";
  // 默认显示源码,不自动渲染 HTML/SVG 预览:流式输出时 iframe 的 srcDoc 会随每个 delta
  // 变化导致疯狂重载闪动(尚未完成的 HTML 一直在高频重绘,视觉灾难);且多数场景用户只
  // 想读代码。需要看渲染效果时点头部"预览"按钮手动切换到 iframe 渲染层。
  const [inlinePreview, setInlinePreview] = React.useState(false);
  const shikiLanguage = React.useMemo(() => resolveShikiLanguage(language), [language]);
  const contextValue = React.useMemo(
    () => ({ code, language: displayLanguage }),
    [code, displayLanguage],
  );

  return (
    <CodeBlockContext.Provider value={contextValue}>
      <CodeBlockContainer className={className} language={displayLanguage} {...props}>
        <CodeBlockHeader>
          <CodeBlockTitle>
            <CodeBlockLanguage>{displayLanguage}</CodeBlockLanguage>
          </CodeBlockTitle>
          <CodeBlockActions>
            {canInlinePreview ? (
              <CodeBlockPreviewButton
                active={inlinePreview}
                onPreview={() => setInlinePreview((current) => !current)}
              />
            ) : null}
            {canPreview && onPreview && <CodeBlockPreviewButton onPreview={onPreview} />}
            <CodeBlockDownloadButton />
            <CodeBlockCopyButton />
          </CodeBlockActions>
        </CodeBlockHeader>
        {inlinePreview && canInlinePreview ? (
          <div className="border-t bg-white">
            <iframe
              title={`${displayLanguage} preview`}
              sandbox="allow-scripts"
              srcDoc={buildInlinePreviewDocument(code, previewLanguage)}
              className="h-[220px] w-full border-0"
            />
          </div>
        ) : (
          <CodeBlockContent
            code={code}
            language={shikiLanguage}
            showLineNumbers={showLineNumbers}
            wrapLines={wrapLines}
          />
        )}
      </CodeBlockContainer>
    </CodeBlockContext.Provider>
  );
}
