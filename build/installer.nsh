; Custom NSIS include — electron-builder merges this via the `nsis.include` option.
; Adds an "Open in Conduit" entry to the Windows Explorer context menu for folders and
; for folder backgrounds, pointing at the installed executable. Written to HKCU to match
; the per-user (perMachine:false) install, so no elevation is required.
;   %1  — the selected folder (Directory right-click)
;   %V  — the open folder (Directory\Background right-click)

!macro customInstall
  WriteRegStr HKCU "Software\Classes\Directory\shell\Conduit" "" "Open in Conduit"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Conduit" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Conduit\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Conduit" "" "Open in Conduit"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Conduit" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Conduit\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Conduit"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Conduit"
!macroend
