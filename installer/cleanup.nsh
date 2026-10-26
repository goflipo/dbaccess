; ── Keep user data across installs / updates ─────────────────────────────────
; Installing or updating must NOT touch %APPDATA%\DB Access: it holds saved
; connections, settings, the encrypted AI API key and the verified-models list.

; ── Post-uninstall cleanup ────────────────────────────────────────────────────
; Only wipe the userData folder on a real uninstall. During an update the old
; version is uninstalled first (with the --updated flag) and must keep the data.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$APPDATA\DB Access"
  ${endIf}
!macroend
