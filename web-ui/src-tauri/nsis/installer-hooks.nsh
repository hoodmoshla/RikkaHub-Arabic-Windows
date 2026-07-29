; Rikkahub installer: ask the user where conversations / config / uploads should live.
;
; This file is `!include`d early by our custom installer template (nsis/installer.template.nsi).
; The actual `Page custom RikkahubDataDirPageCreate RikkahubDataDirPageLeave` directive lives
; in the template itself — placed right after MUI_PAGE_DIRECTORY so the wizard flows:
;   Welcome → License (optional) → Install Dir → Data Dir (this) → Install → Finish.
;
; After files are installed, NSIS_HOOK_POSTINSTALL persists the choice to a plain-text
; handoff file %APPDATA%\com.rikkahub.pc\installer-data-dir.txt. The Rust shell consumes
; it on next launch: merges the path into user-config.json (load-modify-save) and deletes
; the file. The installer NEVER writes user-config.json itself — that file has exactly one
; writer (the shell). 专题6教训:本钩子曾以覆盖模式重写整个 user-config.json 且只写
; data_dir 一个字段,每次升级都会抹掉 minimize_to_tray 等其他用户偏好("托盘设置
; 自己复活"的根因)。交接文件是纯文本裸路径(无 JSON 转义、无尾随换行)。
;
; UPGRADE SAFETY: on re-install, the page reads the previously persisted data_dir from
; user-config.json (written by the Rust shell), falling back to a still-unconsumed
; handoff file (installed but never launched), and SKIPS the page if it finds one.
; Without this, an existing user who once picked e.g. D:\MyData\rikkahub-data would have
; their data_dir silently reset to $INSTDIR\pc-data when they click "下一步" on the
; default-prefilled page, orphaning the old files in place. Cover-installs MUST preserve
; the existing choice.
;
; NOTE: We do not define `.onInit` — the Tauri template owns it.

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"

Var RIKKAHUB_DATA_DIR
Var RIKKAHUB_DATA_TEXT
Var RIKKAHUB_DATA_BROWSE
Var RIKKAHUB_EXISTING_DATA_DIR

Function RikkahubDataDirPageCreate
  ${If} $RIKKAHUB_DATA_DIR == ""
    ; Upgrade path: try to recover the user's previously chosen data_dir. If found, skip the
    ; page entirely so cover-install never loses track of their data.
    Call RikkahubReadExistingDataDir
    ${If} $RIKKAHUB_EXISTING_DATA_DIR != ""
      StrCpy $RIKKAHUB_DATA_DIR $RIKKAHUB_EXISTING_DATA_DIR
      Abort
    ${EndIf}
    ; Fresh install: default mirrors the user's chosen install dir — "数据路径默认跟着 exe 走".
    StrCpy $RIKKAHUB_DATA_DIR "$INSTDIR\pc-data"
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "选择数据保存位置" "对话记录、设置和上传的文件都会放在这里。"

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ; 8-1:应用内没有更换数据目录的入口(升级安装也会跳过本页复用旧目录),文案不得承诺
  ; "应用内随时换位置"。待前端补齐迁移 UI(复制数据→校验→切指针→重启)后再恢复表述。
  ${NSD_CreateLabel} 0u 0u 100% 30u "Rikkahub 会把所有的对话历史、应用设置、上传的文件和导出的备份保存到下面的目录。$\r$\n请谨慎选择：安装后暂不支持在应用内更换位置。"

  ${NSD_CreateLabel} 0u 36u 100% 10u "数据保存目录："

  ${NSD_CreateText} 0u 50u 80% 14u "$RIKKAHUB_DATA_DIR"
  Pop $RIKKAHUB_DATA_TEXT

  ${NSD_CreateBrowseButton} 82% 50u 18% 14u "浏览..."
  Pop $RIKKAHUB_DATA_BROWSE
  ${NSD_OnClick} $RIKKAHUB_DATA_BROWSE RikkahubDataDirBrowse

  ${NSD_CreateLabel} 0u 72u 100% 30u "提示：放到 D 盘等大容量分区可以避免占用系统盘空间，但路径里最好不要包含中文字符。"

  nsDialogs::Show
FunctionEnd

Function RikkahubDataDirPageLeave
  ${NSD_GetText} $RIKKAHUB_DATA_TEXT $RIKKAHUB_DATA_DIR
  ${If} $RIKKAHUB_DATA_DIR == ""
    StrCpy $RIKKAHUB_DATA_DIR "$INSTDIR\pc-data"
  ${EndIf}
FunctionEnd

Function RikkahubDataDirBrowse
  nsDialogs::SelectFolderDialog "选择数据保存位置" "$RIKKAHUB_DATA_DIR"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $RIKKAHUB_DATA_TEXT "$0"
  ${EndIf}
FunctionEnd

; --- Recover existing data_dir --------------------------------------------------------
; Primary source: user-config.json, whose sole writer is the Rust shell
; (serde_json::to_string_pretty). It emits one line of the form:
;   `  "data_dir": "<json-escaped-path>"`
; with a fixed 2-space indent. We search for the literal prefix `"data_dir": "` (13 chars)
; and read until the next `"`. The path is JSON-escaped so `\\` becomes `\` via
; RikkahubUnescapeJson. Anything else (missing file, malformed JSON, `data_dir: null`)
; falls through to the secondary source: a still-unconsumed installer handoff file
; (raw path, single line) from an install that was never launched. Both missing leaves
; $RIKKAHUB_EXISTING_DATA_DIR empty, and the caller falls back to a fresh-install
; default — safe by design.
Function RikkahubReadExistingDataDir
  StrCpy $RIKKAHUB_EXISTING_DATA_DIR ""

  IfFileExists "$APPDATA\com.rikkahub.pc\user-config.json" 0 rded_handoff

  ClearErrors
  FileOpen $0 "$APPDATA\com.rikkahub.pc\user-config.json" r
  IfErrors rded_handoff

rded_loop:
  ClearErrors
  FileRead $0 $1
  IfErrors rded_close

  ${StrLoc} $2 $1 '"data_dir": "' ">"
  StrCmp $2 "" rded_loop

  IntOp $2 $2 + 13    ; len('"data_dir": "') == 13
  StrCpy $3 $1 "" $2

  ${StrLoc} $4 $3 '"' ">"
  StrCmp $4 "" rded_close
  StrCpy $3 $3 $4

  Push $3
  Call RikkahubUnescapeJson
  Pop $RIKKAHUB_EXISTING_DATA_DIR

rded_close:
  FileClose $0

rded_handoff:
  ; config json 没给出 data_dir → 查未消费的交接文件(装了但从没启动过的场景)。
  StrCmp $RIKKAHUB_EXISTING_DATA_DIR "" 0 rded_done
  IfFileExists "$APPDATA\com.rikkahub.pc\installer-data-dir.txt" 0 rded_done
  ClearErrors
  FileOpen $0 "$APPDATA\com.rikkahub.pc\installer-data-dir.txt" r
  IfErrors rded_done
  ClearErrors
  FileRead $0 $1
  FileClose $0
  IfErrors rded_done
  StrCpy $RIKKAHUB_EXISTING_DATA_DIR $1
rded_done:
FunctionEnd

; --- Tauri post-install hook --------------------------------------------------------
; Persist the user's choice to the plain-text handoff file. The Rust shell consumes it
; on next launch (merge into user-config.json, then delete). We deliberately do NOT
; write user-config.json here: rewriting a JSON we don't fully parse clobbers every
; field we don't know about (this is how minimize_to_tray kept resurrecting on updates).
;
; On upgrade where RikkahubDataDirPageCreate skipped the page, $RIKKAHUB_DATA_DIR was
; copied from the existing config and the shell's merge re-writes the same value
; (idempotent). On a fresh install we hand off whatever the user picked.
; No trailing newline — the shell and RikkahubReadExistingDataDir read the line as-is.
!macro NSIS_HOOK_POSTINSTALL
  ${If} $RIKKAHUB_DATA_DIR != ""
    CreateDirectory "$APPDATA\com.rikkahub.pc"
    FileOpen $1 "$APPDATA\com.rikkahub.pc\installer-data-dir.txt" w
    FileWrite $1 '$RIKKAHUB_DATA_DIR'
    FileClose $1
    CreateDirectory "$RIKKAHUB_DATA_DIR"
  ${EndIf}
!macroend

; JSON unescape helper: turns `\\` into `\`. Other escapes (e.g. `\"`, `\n`) are left
; alone — our paths only contain backslashes. Stack in/out, same convention as escape.
Function RikkahubUnescapeJson
  Exch $0
  Push $1
  Push $2
  Push $3
  StrCpy $1 0
  StrCpy $2 ""
unesc_loop:
  StrCpy $3 $0 1 $1
  StrCmp $3 "" unesc_done
  StrCmp $3 "\" 0 unesc_keep
  IntOp $1 $1 + 1
  StrCpy $3 $0 1 $1
  StrCmp $3 "" unesc_trailing
  StrCmp $3 "\" 0 unesc_other
  StrCpy $2 "$2\"
  IntOp $1 $1 + 1
  Goto unesc_loop
unesc_other:
  StrCpy $2 "$2\$3"
  IntOp $1 $1 + 1
  Goto unesc_loop
unesc_trailing:
  StrCpy $2 "$2\"
  Goto unesc_done
unesc_keep:
  StrCpy $2 "$2$3"
  IntOp $1 $1 + 1
  Goto unesc_loop
unesc_done:
  Pop $3
  Pop $1
  Exch $2
  Exch
  Pop $0
FunctionEnd
