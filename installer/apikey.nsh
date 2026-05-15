; ─────────────────────────────────────────────────────────────────────────────
; installer/apikey.nsh
; Adds a License Activation page as the FIRST step of the installer wizard.
;
; Flow:
;   1. User enters API key (+ optional name and email) on this page.
;   2. A temporary PowerShell script calls POST /api/license/check on the
;      licensing server (validates the key without consuming it).
;   3. On success, the details are written to:
;        %APPDATA%\DB Access\pending_license.txt
;      as key=value lines:  apikey=, customer_name=, customer_email=
;   4. On first app launch, Electron reads this file, calls /activate with the
;      real device ID, saves the encrypted key + JWT, and deletes the pending
;      file.  The user never sees an activation screen inside the app.
;
; IMPORTANT: Change the LICENSE_SERVER variable below to your deployed server
;            URL before packaging for distribution.
; ─────────────────────────────────────────────────────────────────────────────

!include "nsDialogs.nsh"
!include "LogicLib.nsh"

; ── Server URL — change before release ───────────────────────────────────────
!define LICENSE_SERVER "https://988nqklt-3500.inc1.devtunnels.ms"

; ── NSIS variables ────────────────────────────────────────────────────────────
Var hDialog
Var hApiKeyInput
Var hNameInput
Var hEmailInput
Var sApiKeyValue
Var sNameValue
Var sEmailValue

; ── Declare the custom page BEFORE MUI pages (runs as first installer step) ──
!macro customHeader
  Page custom ApiKeyPageCreate ApiKeyPageLeave
!macroend

; ─────────────────────────────────────────────────────────────────────────────
; Page UI
; ─────────────────────────────────────────────────────────────────────────────
Function ApiKeyPageCreate
  nsDialogs::Create 1018
  Pop $hDialog
  ${If} $hDialog == error
    Abort
  ${EndIf}

  ; Heading
  ${NSD_CreateLabel} 0 0 100% 14u "License Activation"
  Pop $0
  CreateFont $1 "$(^Font)" "$(^FontSize)" 700
  SendMessage $0 ${WM_SETFONT} $1 1

  ; Description
  ${NSD_CreateLabel} 0 18u 100% 26u \
    "DB Access requires a valid API key to install.$\r$\nPlease enter the key you received."
  Pop $0

  ; ── API Key ────────────────────────────────────────────────────────────────
  ${NSD_CreateLabel} 0 50u 100% 12u "API Key  (format: XXXX-XXXX-XXXX-XXXX)  *required"
  Pop $0

  ${NSD_CreateText} 0 64u 100% 14u "$sApiKeyValue"
  Pop $hApiKeyInput

  ; ── Your Name (optional) ──────────────────────────────────────────────────
  ${NSD_CreateLabel} 0 86u 100% 12u "Your Name  (optional)"
  Pop $0

  ${NSD_CreateText} 0 100u 100% 14u "$sNameValue"
  Pop $hNameInput

  ; ── Email (optional) ─────────────────────────────────────────────────────
  ${NSD_CreateLabel} 0 122u 100% 12u "Email Address  (optional)"
  Pop $0

  ${NSD_CreateText} 0 136u 100% 14u "$sEmailValue"
  Pop $hEmailInput

  ${NSD_SetFocus} $hApiKeyInput
  nsDialogs::Show
FunctionEnd

; ─────────────────────────────────────────────────────────────────────────────
; Validation — called when user clicks Next
; ─────────────────────────────────────────────────────────────────────────────
Function ApiKeyPageLeave
  ${NSD_GetText} $hApiKeyInput $sApiKeyValue
  ${NSD_GetText} $hNameInput   $sNameValue
  ${NSD_GetText} $hEmailInput  $sEmailValue

  ; Basic length guard (XXXX-XXXX-XXXX-XXXX = 19 chars)
  StrLen $0 $sApiKeyValue
  ${If} $0 < 10
    MessageBox MB_OK|MB_ICONEXCLAMATION \
      "Please enter a valid API key (format: XXXX-XXXX-XXXX-XXXX)."
    Abort
  ${EndIf}

  ; ── Write a temp PowerShell script ─────────────────────────────────────────
  GetTempFileName $R0
  FileOpen $R1 "$R0.ps1" w

  FileWrite $R1 "try {$\r$\n"
  FileWrite $R1 "  $$key  = '$sApiKeyValue'$\r$\n"
  FileWrite $R1 "  $$fp   = (Get-WmiObject Win32_ComputerSystem).Name + '|' + [System.Environment]::OSVersion.Platform + '|' + (Get-WmiObject Win32_Processor | Select-Object -First 1).Name$\r$\n"
  FileWrite $R1 "  $$fp   = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($$fp))).Replace('-','').ToLower().Substring(0,32)$\r$\n"
  FileWrite $R1 "  $$body = (@{ apikey = $$key; machine_fingerprint = $$fp } | ConvertTo-Json -Compress)$\r$\n"
  FileWrite $R1 "  $$r    = Invoke-RestMethod -Uri '${LICENSE_SERVER}/api/license/check' ``$\r$\n"
  FileWrite $R1 "             -Method POST -ContentType 'application/json' ``$\r$\n"
  FileWrite $R1 "             -Body $$body -TimeoutSec 20 -ErrorAction Stop$\r$\n"
  FileWrite $R1 "  if ($$r.success)                          { exit 0 }$\r$\n"
  FileWrite $R1 "  elseif ($$r.error -like '*revoked*')      { exit 3 }$\r$\n"
  FileWrite $R1 "  elseif ($$r.error -like '*another device*') { exit 4 }$\r$\n"
  FileWrite $R1 "  else                                      { exit 2 }$\r$\n"
  FileWrite $R1 "} catch {$\r$\n"
  FileWrite $R1 "  exit 1$\r$\n"
  FileWrite $R1 "}$\r$\n"

  FileClose $R1

  ; ── Execute the script ──────────────────────────────────────────────────────
  nsExec::ExecToStack `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$R0.ps1"`
  Pop $0   ; exit code  (nsExec pushes exit code FIRST on stack)
  Pop $1   ; stdout output

  ; Clean up temp files
  Delete "$R0.ps1"
  Delete "$R0"

  ; ── Handle exit codes ───────────────────────────────────────────────────────
  ${If} $0 == 0
    ; Valid key — save details for the app to activate on first launch
    CreateDirectory "$APPDATA\DB Access"
    FileOpen $R1 "$APPDATA\DB Access\pending_license.txt" w
    FileWrite $R1 "apikey=$sApiKeyValue$\r$\n"
    FileWrite $R1 "customer_name=$sNameValue$\r$\n"
    FileWrite $R1 "customer_email=$sEmailValue$\r$\n"
    FileClose $R1
    ; Continue → installer proceeds to next page

  ${ElseIf} $0 == 4
    MessageBox MB_OK|MB_ICONEXCLAMATION \
      "This API key is already activated on a different device.$\nEach key can only be used on one machine.$\nPlease contact support if you need to transfer your license."
    Abort

  ${ElseIf} $0 == 3
    MessageBox MB_OK|MB_ICONEXCLAMATION \
      "This API key has been revoked.$\nPlease contact support for a replacement."
    Abort

  ${ElseIf} $0 == 2
    MessageBox MB_OK|MB_ICONEXCLAMATION \
      "Invalid API key. Please check your key and try again."
    Abort

  ${ElseIf} $0 == 1
    ; Network error — offer Retry or Cancel
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
      "Cannot reach the license server.$\nPlease check your internet connection and try again." \
      IDRETRY LicRetry
    ; Cancel clicked → quit installer
    Quit
    LicRetry:
    ; Retry clicked → go back to this page
    Abort

  ${Else}
    MessageBox MB_OK|MB_ICONEXCLAMATION \
      "Unexpected error (code $0). Please restart the installer and try again."
    Abort
  ${EndIf}
FunctionEnd
