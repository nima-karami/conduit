; Custom NSIS include — electron-builder merges this via the `nsis.include` option.
; Adds OS integration for opening folders AND files in Conduit. All keys are written to
; HKCU to match the per-user (perMachine:false) install, so no elevation is required.
;
; Folder context menu (shipped): "Open in Conduit" on a Directory and its Background.
;   %1  — the selected folder (Directory right-click)
;   %V  — the open folder (Directory\Background right-click)
;
; File integration (this spec): a universal "Open with Conduit" entry on every file, an
; Applications ProgID so Conduit shows in "Open with → Choose another app", and a
; Default-Apps capability registration so the user can set Conduit as the default editor
; per type (Settings → Default apps).
;   %1  — the selected/opened file

; Curated extension set for SupportedTypes + Default-Apps FileAssociations: the text/code/
; config surface Conduit's viewers handle. Keep in sync with docs/specs/archive/2026-06-19-os-file-open.md.
; (`.pdf` is included now that the in-app PDF viewer has shipped — see 2026-06-19-pdf-viewer.md.)
!define CONDUIT_DOC_PROGID "Conduit.Document"
!macro ConduitForEachExt _cmd
  !insertmacro ${_cmd} ".txt"
  !insertmacro ${_cmd} ".md"
  !insertmacro ${_cmd} ".markdown"
  !insertmacro ${_cmd} ".json"
  !insertmacro ${_cmd} ".jsonc"
  !insertmacro ${_cmd} ".yml"
  !insertmacro ${_cmd} ".yaml"
  !insertmacro ${_cmd} ".toml"
  !insertmacro ${_cmd} ".xml"
  !insertmacro ${_cmd} ".csv"
  !insertmacro ${_cmd} ".log"
  !insertmacro ${_cmd} ".ini"
  !insertmacro ${_cmd} ".env"
  !insertmacro ${_cmd} ".js"
  !insertmacro ${_cmd} ".jsx"
  !insertmacro ${_cmd} ".ts"
  !insertmacro ${_cmd} ".tsx"
  !insertmacro ${_cmd} ".mjs"
  !insertmacro ${_cmd} ".cjs"
  !insertmacro ${_cmd} ".css"
  !insertmacro ${_cmd} ".scss"
  !insertmacro ${_cmd} ".less"
  !insertmacro ${_cmd} ".html"
  !insertmacro ${_cmd} ".htm"
  !insertmacro ${_cmd} ".py"
  !insertmacro ${_cmd} ".rs"
  !insertmacro ${_cmd} ".go"
  !insertmacro ${_cmd} ".rb"
  !insertmacro ${_cmd} ".java"
  !insertmacro ${_cmd} ".kt"
  !insertmacro ${_cmd} ".c"
  !insertmacro ${_cmd} ".h"
  !insertmacro ${_cmd} ".cpp"
  !insertmacro ${_cmd} ".hpp"
  !insertmacro ${_cmd} ".cs"
  !insertmacro ${_cmd} ".php"
  !insertmacro ${_cmd} ".lua"
  !insertmacro ${_cmd} ".sh"
  !insertmacro ${_cmd} ".bash"
  !insertmacro ${_cmd} ".zsh"
  !insertmacro ${_cmd} ".ps1"
  !insertmacro ${_cmd} ".sql"
  !insertmacro ${_cmd} ".gitignore"
  !insertmacro ${_cmd} ".dockerfile"
  !insertmacro ${_cmd} ".pdf"
!macroend

; SupportedTypes entry: an empty value under Applications\<exe>\SupportedTypes\<ext>.
!macro ConduitWriteSupportedType _ext
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" "${_ext}" ""
!macroend

; Default-Apps FileAssociation: map an extension to the shared Conduit.Document ProgID.
!macro ConduitWriteFileAssoc _ext
  WriteRegStr HKCU "Software\Conduit\Capabilities\FileAssociations" "${_ext}" "${CONDUIT_DOC_PROGID}"
!macroend

!macro customInstall
  ; ── Folder context menu (shipped) ──────────────────────────────────────────
  WriteRegStr HKCU "Software\Classes\Directory\shell\Conduit" "" "Open in Conduit"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Conduit" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Conduit\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Conduit" "" "Open in Conduit"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Conduit" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Conduit\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'

  ; ── Universal "Open with Conduit" on every file (`*` = all-files class) ──────
  WriteRegStr HKCU "Software\Classes\*\shell\Conduit" "" "Open with Conduit"
  WriteRegStr HKCU "Software\Classes\*\shell\Conduit" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\*\shell\Conduit\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; ── Application registration (ProgID) — "Open with → Choose another app" ─────
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "Conduit"
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open" "FriendlyAppName" "Conduit"
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  !insertmacro ConduitForEachExt ConduitWriteSupportedType

  ; ── Shared ProgID the Default-Apps associations point at ─────────────────────
  WriteRegStr HKCU "Software\Classes\${CONDUIT_DOC_PROGID}" "" "Conduit Document"
  WriteRegStr HKCU "Software\Classes\${CONDUIT_DOC_PROGID}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\${CONDUIT_DOC_PROGID}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; ── Default-Apps capability + RegisteredApplications (Settings → Default apps) ─
  WriteRegStr HKCU "Software\Conduit\Capabilities" "ApplicationName" "Conduit"
  WriteRegStr HKCU "Software\Conduit\Capabilities" "ApplicationDescription" "Open files and folders in Conduit."
  !insertmacro ConduitForEachExt ConduitWriteFileAssoc
  WriteRegStr HKCU "Software\RegisteredApplications" "Conduit" "Software\Conduit\Capabilities"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Conduit"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Conduit"
  DeleteRegKey HKCU "Software\Classes\*\shell\Conduit"
  DeleteRegKey HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  DeleteRegKey HKCU "Software\Classes\${CONDUIT_DOC_PROGID}"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Conduit"
  DeleteRegKey HKCU "Software\Conduit"
!macroend
