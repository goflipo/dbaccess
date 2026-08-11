; ── Pre-install cleanup ──────────────────────────────────────────────────────
; Runs before the installer UI appears (.onInit).
; Removes any leftover app data from a previous installation so the new
; install always starts completely clean (license, settings, connections, etc.)
!macro customInit
  RMDir /r "$APPDATA\DB Access"
!macroend

; ── Post-uninstall cleanup ────────────────────────────────────────────────────
; Electron-builder removes program files but leaves AppData intact by default.
; This wipes the entire userData folder so nothing is left behind after removal.
!macro customUnInstall
  RMDir /r "$APPDATA\DB Access"
!macroend
