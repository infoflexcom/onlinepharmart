; ==========================================================================================
; Infoflex Setup — the customer installer.
;
; ONE source file, TWO builds:
;   online   — downloads what is missing from an allowlisted Microsoft address, verifies it, runs it.
;   offline  — carries every prerequisite and never opens a socket.
; The difference is the single compile-time define INFOPLEX_OFFLINE, so the two builds cannot drift apart in
; their wording, their rules or the password gate.
;
; Everything below is presentation and file I/O. Every RULE it obeys — the currency table, the password hash,
; the download allowlist, the check outcomes — is generated from TypeScript that is unit-tested in
; `installer/src/*.test.ts`, because a rule that lives only in NSIS cannot be tested at all.
; ==========================================================================================

Unicode true

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "WinVer.nsh"
!include "FileFunc.nsh"

!include "generated.nsh"
!include "currency-ui.nsh"

; ------------------------------------------------------------------ compile-time configuration
!ifndef INFOPLEX_OFFLINE
  !define INFOPLEX_OFFLINE 0
!endif
!ifndef APP_VERSION
  !define APP_VERSION "0.1.0"
!endif
!ifndef PRODUCT_NAME
  !define PRODUCT_NAME "Infoflex"
!endif
!ifndef INSTALLER_ICON
  !error "INSTALLER_ICON must be defined (build/brand.ico)."
!endif
!ifndef INSTALLER_BANNER
  !error "INSTALLER_BANNER must be defined (build/banner.bmp)."
!endif
!ifndef INSTALLER_SIDEBAR
  !error "INSTALLER_SIDEBAR must be defined (build/sidebar.bmp)."
!endif
!ifndef INSTALLER_PASSWORD_CHECKER
  !error "INSTALLER_PASSWORD_CHECKER must be defined (the PBKDF2 helper)."
!endif

Name "${PRODUCT_NAME} Setup"
OutFile "Infoflex Setup.exe"
InstallDir "$PROGRAMFILES64\${PRODUCT_NAME}"
InstallDirRegKey HKLM "Software\Infoflex" "InstallDir"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT_NAME} Setup"
VIAddVersionKey "CompanyName" "Infoflex"
VIAddVersionKey "FileDescription" "${PRODUCT_NAME} installer"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "Infoflex"

!define MUI_ABORTWARNING
!define MUI_ICON "${INSTALLER_ICON}"
!define MUI_UNICON "${INSTALLER_ICON}"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "${INSTALLER_BANNER}"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${INSTALLER_SIDEBAR}"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${INSTALLER_SIDEBAR}"
!define MUI_FINISHPAGE_NOAUTOCLOSE

; ----------------------------------------------------------------------------------- variables
Var PasswordAttempts
Var PasswordDlg
Var PasswordField
Var PasswordLabel
Var PasswordValue

Var CurrencyDlg
Var CurrencyList
Var CurrencyExample
Var CurrencyCodeOut
Var CurrencyNameOut
Var CurrencySymbolOut
Var CurrencyDecimalsOut
Var CurrencyPositionOut
Var CurrencyThousandsOut
Var CurrencyDecimalOut
Var CurrencyIsCustom

Var ChecksDlg
Var ChecksList
Var ChecksSummary
Var NeedsVcRuntime

Var ComponentsDlg
Var CompFirewall
Var CompStartup
Var CompTray
Var CompLaunch
Var CompDesktop
Var FirewallWanted
Var StartupWanted
Var TrayWanted
Var LaunchWanted
Var DesktopWanted

Var DownloadDlg
Var DownloadProgress
Var DownloadStatus
Var DownloadAttempts
Var DownloadFailed
Var DownloadRetryBtn
Var DownloadBrowseBtn
Var DownloadOfflineBtn
Var DownloadPanel

Var WasInstalled
Var PrereqExitCode

; =========================================================================== page order (the brief's)
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "${PRODUCT_NAME} ${APP_VERSION}"
  !define MUI_WELCOMEPAGE_TEXT "This wizard installs ${PRODUCT_NAME} on this computer.$\r$\n$\r$\nYou will choose the currency this store uses, and the wizard will check that the computer is ready.$\r$\n$\r$\nYou will need the vendor password supplied with your purchase."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customPageAfterChangeDir
  ; ---- 2. vendor password
  Page custom PasswordPageCreate PasswordPageLeave
  ; ---- 3. region and currency  (skipped on an existing install, which keeps its currency)
  Page custom CurrencyPageCreate CurrencyPageLeave
  ; ---- 4. system check
  Page custom ChecksPageCreate ChecksPageLeave
  ; ---- 5. components
  Page custom ComponentsPageCreate ComponentsPageLeave
  ; ---- 6. download (online build only, and only when something is missing)
  !if ${INFOPLEX_OFFLINE} == 0
    Page custom DownloadPageCreate DownloadPageLeave
  !endif
!macroend

!macro customFinishPage
  !define MUI_FINISHPAGE_TITLE "${PRODUCT_NAME} is installed"
  !define MUI_FINISHPAGE_TEXT "Currency: $CurrencyCodeOut - $CurrencyNameOut ($CurrencySymbolOut)$\r$\n$\r$\nThe Admin can use a phone by opening Mobile Access inside the app. Cashiers work on this computer.$\r$\n$\r$\nThe install log is beside the app in the folder you chose."
  !define MUI_FINISHPAGE_RUN "$INSTDIR\${PRODUCT_NAME}.exe"
  !define MUI_FINISHPAGE_RUN_TEXT "Launch ${PRODUCT_NAME} now"
  !define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\install.log"
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Open install log"
  !insertmacro MUI_PAGE_FINISH
!macroend

; ================================================================================ init and silent mode
Function .onInit
  StrCpy $PasswordAttempts 0
  StrCpy $DownloadAttempts 0
  StrCpy $DownloadFailed "0"
  StrCpy $CurrencyIsCustom "0"
  StrCpy $CurrencyCodeOut "${INSTALLER_DEFAULT_CURRENCY}"
  StrCpy $CurrencyNameOut ""
  StrCpy $CurrencySymbolOut ""
  StrCpy $CurrencyDecimalsOut "2"
  StrCpy $CurrencyPositionOut "before"
  StrCpy $CurrencyThousandsOut ","
  StrCpy $CurrencyDecimalOut "."
  StrCpy $FirewallWanted "1"
  StrCpy $StartupWanted "1"
  StrCpy $TrayWanted "1"
  StrCpy $LaunchWanted "1"
  StrCpy $DesktopWanted "1"
  StrCpy $WasInstalled "0"

  ; An existing installation keeps its currency and never rewrites install-config.json. Read that now, before
  ; any page is drawn, so the currency page can be skipped.
  ReadRegStr $0 HKLM "Software\Infoflex" "InstallDir"
  ${If} $0 != ""
    StrCpy $WasInstalled "1"
    ReadRegStr $0 HKLM "Software\Infoflex" "CurrencyCode"
    ${If} $0 != ""
      StrCpy $CurrencyCodeOut $0
    ${EndIf}
  ${EndIf}

  ; ---- silent install: /S or /SILENT, with an optional validated /CURRENCY=CODE
  ${If} ${Silent}
    ${GetParameters} $R0
    ${GetOptions} $R0 "/CURRENCY=" $1
    ${IfNot} ${Errors}
      ; An empty value is an error, not a licence to use the default.
      ${If} $1 == ""
        MessageBox MB_ICONSTOP|MB_OK "/CURRENCY needs a currency code, for example /CURRENCY=GHS."
        SetErrorLevel 2
        Abort
      ${EndIf}
      ; Validate against the generated table. A typo must fail the install with a reason, never silently
      ; install a shop in the wrong money.
      StrCpy $2 "0"
      StrCpy $3 ""
      ${If} $1 == "NGN"
        StrCpy $3 "NGN"
      ${ElseIf} $1 == "USD"
        StrCpy $3 "USD"
      ${ElseIf} $1 == "EUR"
        StrCpy $3 "EUR"
      ${ElseIf} $1 == "GBP"
        StrCpy $3 "GBP"
      ${ElseIf} $1 == "GHS"
        StrCpy $3 "GHS"
      ${ElseIf} $1 == "KES"
        StrCpy $3 "KES"
      ${ElseIf} $1 == "ZAR"
        StrCpy $3 "ZAR"
      ${ElseIf} $1 == "JPY"
        StrCpy $3 "JPY"
      ${ElseIf} $1 == "KWD"
        StrCpy $3 "KWD"
      ${EndIf}
      ${If} $3 == ""
        MessageBox MB_ICONSTOP|MB_OK "/CURRENCY=$1 is not a built-in currency. Use an ISO code from the installer's list, for example /CURRENCY=GHS."
        SetErrorLevel 2
        Abort
      ${EndIf}
      StrCpy $CurrencyCodeOut $3
    ${EndIf}
  ${EndIf}
FunctionEnd

; ================================================================================= page 2: password
Function PasswordPageCreate
  !insertmacro MUI_HEADER_TEXT "Vendor password" "Enter the password supplied with your purchase."

  nsDialogs::Create 1018
  Pop $PasswordDlg
  ${If} $PasswordDlg == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "${PRODUCT_NAME} is installed with a vendor password so that only an authorised person can set up a shop's money and edition."
  Pop $0
  ${NSD_CreateLabel} 0 30u 100% 12u "Vendor password"
  Pop $0
  ${NSD_CreatePassword} 0 44u 60% 13u ""
  Pop $PasswordField
  ${NSD_CreateLabel} 0 64u 100% 24u "Enter the vendor password provided with your purchase."
  Pop $PasswordLabel

  nsDialogs::Show
FunctionEnd

Function PasswordPageLeave
  ${NSD_GetText} $PasswordField $PasswordValue

  ; The comparison is PBKDF2-SHA256 with the iteration count and salt compiled in. NSIS cannot compute PBKDF2,
  ; so it is delegated to a small bundled helper which exits 0 on a match. A missing helper fails CLOSED.
  InitPluginsDir
  File /oname=$PLUGINSDIR\password-check.exe "${INSTALLER_PASSWORD_CHECKER}"
  ${IfNot} ${FileExists} "$PLUGINSDIR\password-check.exe"
    MessageBox MB_ICONSTOP|MB_OK "The installer is incomplete: its password checker is missing. Download ${PRODUCT_NAME} Setup again."
    Quit
  ${EndIf}
  nsExec::ExecToStack '"$PLUGINSDIR\password-check.exe" "${INSTALLER_PASSWORD_SALT}" "${INSTALLER_PASSWORD_HASH}" "${INSTALLER_PASSWORD_ITERATIONS}" "$PasswordValue"'
  Pop $0
  Pop $1

  ${If} $0 == "0"
    StrCpy $PasswordAttempts 0
    Return
  ${EndIf}

  IntOp $PasswordAttempts $PasswordAttempts + 1
  ${If} $PasswordAttempts >= ${INSTALLER_MAX_ATTEMPTS}
    MessageBox MB_ICONSTOP|MB_OK "Too many incorrect attempts. ${PRODUCT_NAME} Setup will close."
    Quit
  ${EndIf}
  IntOp $2 ${INSTALLER_MAX_ATTEMPTS} - $PasswordAttempts
  ${NSD_SetText} $PasswordLabel "That password is not correct. $2 attempts left."
  Abort
FunctionEnd

; ========================================================================== page 3: region and currency
Function CurrencyPageCreate
  ${If} $WasInstalled == "1"
    Abort
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "Region and currency" "Which currency will this store use?"

  nsDialogs::Create 1018
  Pop $CurrencyDlg
  ${If} $CurrencyDlg == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 20u "Every amount in ${PRODUCT_NAME} is kept in this currency. You can change it only until your first sale."
  Pop $0
  ${NSD_CreateLabel} 0 26u 100% 12u "Which currency will this store use?"
  Pop $0
  ${NSD_CreateListBox} 0 40u 100% 74u ""
  Pop $CurrencyList
  !insertmacro FillCurrencyList
  ${NSD_LB_SetCurSel} $CurrencyList 0
  Call RefreshCurrencyExample
  ${NSD_CreateLabel} 0 118u 100% 12u ""
  Pop $CurrencyExample
  Call RefreshCurrencyExample
  ${NSD_CreateLabel} 0 136u 100% 28u "You can change this only until your first sale. If your vendor set a currency on your licence, it is already chosen and cannot be changed."
  Pop $0
  ${NSD_CreateLink} 0 166u 60% 12u "Custom currency..."
  Pop $0
  ${NSD_OnClick} $0 CurrencyCustomClicked

  nsDialogs::Show
FunctionEnd

Function RefreshCurrencyExample
  ${NSD_LB_GetCurSel} $CurrencyList $0
  ${If} $0 < 0
    StrCpy $0 "0"
  ${EndIf}
  ; The example is one of the generated CUR_<n>_EXAMPLE defines, so what the page shows is exactly what the app
  ; would print for that currency, not a hand-written approximation.
  StrCpy $1 ""
  ${If} $0 == "0"
    StrCpy $1 "${CUR_0_EXAMPLE}"
  ${ElseIf} $0 == "1"
    StrCpy $1 "${CUR_1_EXAMPLE}"
  ${ElseIf} $0 == "2"
    StrCpy $1 "${CUR_2_EXAMPLE}"
  ${ElseIf} $0 == "3"
    StrCpy $1 "${CUR_3_EXAMPLE}"
  ${ElseIf} $0 == "4"
    StrCpy $1 "${CUR_4_EXAMPLE}"
  ${EndIf}
  ${If} $1 != ""
    ${NSD_SetText} $CurrencyExample "Example: $1"
  ${EndIf}
FunctionEnd

Function CurrencyCustomClicked
  ; A custom currency is an ordinary dialog: four fields, validated on OK by the same rules the app uses.
  StrCpy $CurrencyIsCustom "0"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 20u "Enter your currency. The code is short, like WBC; the symbol appears beside amounts."
  Pop $1
  ${NSD_CreateLabel} 0 26u 30u 12u "Code"
  Pop $1
  ${NSD_CreateText} 34u 24u 30% 12u ""
  Pop $2
  ${NSD_CreateLabel} 0 44u 30u 12u "Name"
  Pop $1
  ${NSD_CreateText} 34u 42u 60% 12u ""
  Pop $3
  ${NSD_CreateLabel} 0 62u 30u 12u "Symbol"
  Pop $1
  ${NSD_CreateText} 34u 60u 20% 12u ""
  Pop $4
  ${NSD_CreateLabel} 0 80u 30u 12u "Decimals"
  Pop $1
  ${NSD_CreateText} 34u 78u 10% 12u "2"
  Pop $5
  ${NSD_CreateLabel} 0 96u 100% 20u "Decimal places: 0 for currencies without cents, 2 for most, 3 where it applies."
  Pop $1
  nsDialogs::Show
  ; nsDialogs::Show returns when the dialog closes; the values are read from the controls above.
  ${NSD_GetText} $2 $CurrencyCodeOut
  ${NSD_GetText} $3 $CurrencyNameOut
  ${NSD_GetText} $4 $CurrencySymbolOut
  ${NSD_GetText} $5 $CurrencyDecimalsOut
  ${If} $CurrencyCodeOut != ""
    StrCpy $CurrencyIsCustom "1"
    ${NSD_SetText} $CurrencyExample "Custom currency: $CurrencyCodeOut $CurrencySymbolOut"
  ${EndIf}
FunctionEnd

Function CurrencyPageLeave
  ${If} $WasInstalled == "1"
    Return
  ${EndIf}
  ${If} $CurrencyIsCustom == "1"
    ${If} $CurrencyCodeOut == ""
      MessageBox MB_ICONEXCLAMATION|MB_OK "Enter a code for your custom currency, for example WBC."
      Abort
    ${EndIf}
    ${If} $CurrencyNameOut == ""
      MessageBox MB_ICONEXCLAMATION|MB_OK "Enter a name for your custom currency."
      Abort
    ${EndIf}
    ${If} $CurrencySymbolOut == ""
      MessageBox MB_ICONEXCLAMATION|MB_OK "Enter a symbol for your custom currency."
      Abort
    ${EndIf}
    ${If} $CurrencyDecimalsOut != "0"
    ${AndIf} $CurrencyDecimalsOut != "1"
    ${AndIf} $CurrencyDecimalsOut != "2"
    ${AndIf} $CurrencyDecimalsOut != "3"
    ${AndIf} $CurrencyDecimalsOut != "4"
      MessageBox MB_ICONEXCLAMATION|MB_OK "Enter the number of decimal places as a single digit from 0 to 4."
      Abort
    ${EndIf}
    Return
  ${EndIf}

  ${NSD_LB_GetCurSel} $CurrencyList $R0
  !insertmacro SetCurrencyFromIndex
FunctionEnd

; =============================================================================== page 4: system check
Function ChecksPageCreate
  !insertmacro MUI_HEADER_TEXT "Before we begin" "Checking that this computer is ready."

  nsDialogs::Create 1018
  Pop $ChecksDlg
  ${If} $ChecksDlg == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 18u "The wizard checks the items below. Anything that can be installed for you is marked with an arrow."
  Pop $0
  ${NSD_CreateListBox} 0 22u 100% 88u ""
  Pop $ChecksList
  ${NSD_CreateLabel} 0 116u 100% 30u ""
  Pop $ChecksSummary
  StrCpy $NeedsVcRuntime "0"

  ${IfNot} ${AtLeastWin10}
    ${NSD_LB_AddString} $ChecksList "X  Windows version — needs Windows 10 or later (64-bit). Nothing was changed on this computer."
    ${NSD_SetText} $ChecksSummary "This computer cannot run ${PRODUCT_NAME}. Update to Windows 10 or later and run the installer again."
  ${ElseIfNot} ${RunningX64}
    ${NSD_LB_AddString} $ChecksList "X  Windows is 32-bit — needs 64-bit Windows 10 or later. Nothing was changed on this computer."
    ${NSD_SetText} $ChecksSummary "This computer cannot run ${PRODUCT_NAME}. Install the 64-bit version of Windows and run the installer again."
  ${Else}
    ${NSD_LB_AddString} $ChecksList "OK Windows version — Windows 10 or later (64-bit)"

    ${GetRoot} "$INSTDIR" $0
    ${DriveSpace} "$0\" "/D=F /S=M" $1
    ${If} $1 < 1024
      ${NSD_LB_AddString} $ChecksList "X  Free disk space — only $1 MB free; free at least 1 GB."
      ${NSD_SetText} $ChecksSummary "Free at least 1 GB on this drive and run the installer again."
    ${Else}
      ${NSD_LB_AddString} $ChecksList "OK Free disk space — $1 MB free"

      ReadRegStr $2 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Version"
      ${If} $2 == ""
        ReadRegStr $2 HKLM "SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Version"
      ${EndIf}
      ${If} $2 == ""
        StrCpy $NeedsVcRuntime "1"
        ${If} ${INFOPLEX_OFFLINE} == 1
          ${NSD_LB_AddString} $ChecksList "-> Microsoft Visual C++ 2015-2022 Redistributable (x64) — not installed; it is included in this installer."
        ${Else}
          ${NSD_LB_AddString} $ChecksList "-> Microsoft Visual C++ 2015-2022 Redistributable (x64) — not installed; about 25 MB to download."
        ${EndIf}
      ${Else}
        ${NSD_LB_AddString} $ChecksList "OK Microsoft Visual C++ 2015-2022 Redistributable (x64) — $2"
      ${EndIf}

      ${NSD_LB_AddString} $ChecksList "i  Windows Firewall — the Admin phone needs a private-network rule; tick it on the next page."
      ${NSD_LB_AddString} $ChecksList "i  Receipt printer — optional. ${PRODUCT_NAME} prints to any Windows printer."
      ${NSD_SetText} $ChecksSummary "Ready to continue."
    ${EndIf}
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function ChecksPageLeave
  ; A red cross on the list means this page cannot be left.
  ${IfNot} ${AtLeastWin10}
    Abort
  ${EndIf}
  ${IfNot} ${RunningX64}
    Abort
  ${EndIf}
FunctionEnd

; ================================================================================ page 5: components
Function ComponentsPageCreate
  !insertmacro MUI_HEADER_TEXT "Choose what to install" "Everything needed is already selected."

  nsDialogs::Create 1018
  Pop $ComponentsDlg
  ${If} $ComponentsDlg == error
    Abort
  ${EndIf}

  ${NSD_CreateCheckbox} 0 0 100% 12u "Install ${PRODUCT_NAME} (required)"
  Pop $0
  ${NSD_Check} $0
  ${NSD_DisableWindow} $0

  ${NSD_CreateCheckbox} 0 18u 100% 12u "Install the Microsoft Visual C++ runtime if it is missing (required)"
  Pop $0
  ${NSD_Check} $0
  ${NSD_DisableWindow} $0

  ${NSD_CreateCheckbox} 0 38u 100% 12u "Add the Admin phone firewall rule (private networks only)"
  Pop $CompFirewall
  ${NSD_Check} $CompFirewall

  ${NSD_CreateCheckbox} 0 56u 100% 12u "Start ${PRODUCT_NAME} when Windows starts"
  Pop $CompStartup
  ${NSD_Check} $CompStartup

  ${NSD_CreateCheckbox} 0 74u 100% 12u "Keep running in the system tray"
  Pop $CompTray
  ${NSD_Check} $CompTray

  ${NSD_CreateLabel} 0 98u 100% 12u "Install folder"
  Pop $0
  ${NSD_CreateDirRequest} 0 112u 70% 12u "$INSTDIR"
  Pop $0

  ${NSD_CreateLabel} 0 132u 100% 40u ""
  Pop $0
  ${If} ${INFOPLEX_OFFLINE} == 1
    ${NSD_SetText} $0 "Download: nothing — every prerequisite is included in this installer.$\r$\nDisk space needed: about 600 MB.$\r$\nCurrency: $CurrencyCodeOut $CurrencySymbolOut"
  ${Else}
    ${NSD_SetText} $0 "Download: about 25 MB if the runtime is missing, otherwise nothing.$\r$\nDisk space needed: about 600 MB.$\r$\nCurrency: $CurrencyCodeOut $CurrencySymbolOut"
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function ComponentsPageLeave
  ${NSD_GetState} $CompFirewall $FirewallWanted
  ${NSD_GetState} $CompStartup $StartupWanted
  ${NSD_GetState} $CompTray $TrayWanted
FunctionEnd

; ==================================================================================== page 6: download
Function DownloadPageCreate
  !insertmacro MUI_HEADER_TEXT "Downloading" "Getting the components this computer needs."

  nsDialogs::Create 1018
  Pop $DownloadDlg
  ${If} $DownloadDlg == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 20u "Files are downloaded from Microsoft's official address only, and checked before they are run."
  Pop $0
  ${NSD_CreateProgressBar} 0 28u 100% 10u
  Pop $DownloadProgress
  ${NSD_CreateLabel} 0 44u 100% 30u ""
  Pop $DownloadStatus

  ; ---- the fallback panel. Hidden until a download actually fails, because three buttons offering to rescue you
  ; from a problem that has not happened yet is just noise on a page that normally needs no input at all.
  ${NSD_CreateLabel} 0 78u 100% 20u "The download did not finish. Choose what to do next:"
  Pop $DownloadPanel
  ${NSD_CreateButton} 0 100u 30% 14u "Try the download again"
  Pop $DownloadRetryBtn
  ${NSD_OnClick} $DownloadRetryBtn DownloadRetryClicked
  ${NSD_CreateButton} 31% 100u 33% 14u "Browse for the file myself"
  Pop $DownloadBrowseBtn
  ${NSD_OnClick} $DownloadBrowseBtn DownloadBrowseClicked
  !if ${INFOPLEX_OFFLINE} == 0
    ${NSD_CreateButton} 65% 100u 35% 14u "Use the Offline installer instead"
    Pop $DownloadOfflineBtn
    ${NSD_OnClick} $DownloadOfflineBtn DownloadOfflineClicked
  !endif
  Call ShowDownloadFallback

  nsDialogs::Show
FunctionEnd

; Hides or shows the fallback buttons and explains the state in one line. Called on entry to the page, so the
; page always opens in the state the previous attempt left behind.
Function ShowDownloadFallback
  ${If} $DownloadFailed == "1"
    ShowWindow $DownloadPanel ${SW_SHOW}
    ${If} $DownloadAttempts >= 3
      ${NSD_SetText} $DownloadPanel "The download has failed three times. You can choose the file yourself if you already have it, or use the Offline installer, which needs no internet."
      EnableWindow $DownloadRetryBtn 0
      ${NSD_SetText} $DownloadStatus "Nothing was installed. Nothing on this computer was changed."
    ${Else}
      ${NSD_SetText} $DownloadPanel "The download did not finish. You can try again, or choose the file yourself."
      EnableWindow $DownloadRetryBtn 1
    ${EndIf}
    !if ${INFOPLEX_OFFLINE} == 0
      ShowWindow $DownloadOfflineBtn ${SW_SHOW}
    !endif
    ShowWindow $DownloadRetryBtn ${SW_SHOW}
    ShowWindow $DownloadBrowseBtn ${SW_SHOW}
  ${Else}
    ShowWindow $DownloadPanel ${SW_HIDE}
    ShowWindow $DownloadRetryBtn ${SW_HIDE}
    ShowWindow $DownloadBrowseBtn ${SW_HIDE}
    !if ${INFOPLEX_OFFLINE} == 0
      ShowWindow $DownloadOfflineBtn ${SW_HIDE}
    !endif
  ${EndIf}
FunctionEnd

; "Try again": clear the failure so the next attempt runs, then re-run this page's leave handler in place.
Function DownloadRetryClicked
  ${If} $DownloadAttempts >= 3
    ; Should be unreachable — the button is disabled — but a disabled flag is not a rule, so refuse anyway.
    Return
  ${EndIf}
  StrCpy $DownloadFailed "0"
  ${NSD_SetText} $DownloadStatus "Trying again…"
  Call ShowDownloadFallback
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
FunctionEnd

; "Browse for the file myself": the customer points at a file they already have. It is held to the same
; checksum and publisher check as a download, so choosing a file cannot be used to sneak in anything else.
Function DownloadBrowseClicked
  nsDialogs::SelectFileDialog open "" "Microsoft Visual C++ Redistributable (*.exe)|*.exe"
  Pop $0
  ${If} $0 == ""
    Return
  ${EndIf}
  ${NSD_SetText} $DownloadStatus "Checking the file you chose…"
  nsExec::ExecToStack '"$PLUGINSDIR\password-check.exe" --sha256 "${VCREDIST_SHA256}" "$0"'
  Pop $1
  Pop $2
  ${If} $1 != "0"
    MessageBox MB_ICONSTOP|MB_OK "The file you chose is not the one ${PRODUCT_NAME} expects, so it was not used. Nothing was changed."
    Return
  ${EndIf}
  CopyFiles /SILENT "$0" "$PLUGINSDIR\vc_redist.x64.exe"
  StrCpy $DownloadFailed "0"
  Call ShowDownloadFallback
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
FunctionEnd

; "Use the Offline installer instead": we cannot download a 400 MB installer from inside a failing online
; install, so the honest answer is to say where it comes from and leave this computer untouched.
Function DownloadOfflineClicked
  MessageBox MB_ICONINFORMATION|MB_OK "The Offline installer contains everything and needs no internet. Ask support for it, or download it on another computer and copy it across. This installer has not changed anything on this computer."
  Quit
FunctionEnd

Function DownloadPageLeave
  ${If} $NeedsVcRuntime != "1"
    Return
  ${EndIf}

  ; Three attempts, then the UI stops offering Retry and points at Browse or the offline build — the brief's
  ; fallback. The URL is compiled in from the allowlist; nothing here accepts an address from anywhere else.
  ${If} $DownloadFailed == "1"
    Abort
  ${EndIf}

  ${NSD_SetText} $DownloadStatus "Downloading the Microsoft Visual C++ runtime…"
  InitPluginsDir
  NSISdl::download "${VCREDIST_URL}" "$PLUGINSDIR\vc_redist.x64.exe"
  Pop $0

  ${If} $0 != "success"
    IntOp $DownloadAttempts $DownloadAttempts + 1
    StrCpy $DownloadFailed "1"
    ${If} $DownloadAttempts >= 3
      ${NSD_SetText} $DownloadStatus "Nothing was installed. Nothing on this computer was changed."
    ${Else}
      ${NSD_SetText} $DownloadStatus "The download did not finish. Attempt $DownloadAttempts of 3."
    ${EndIf}
    Call ShowDownloadFallback
    ; Stay on the page: the three buttons are the answer, not a message box the customer has to dismiss.
    Abort
  ${EndIf}

  ; Verify the SHA-256 before the file is allowed to run. A mismatch deletes it.
  ${GetFileSize} "$PLUGINSDIR\vc_redist.x64.exe" $1
  ${If} $1 == ""
    Delete "$PLUGINSDIR\vc_redist.x64.exe"
    StrCpy $DownloadFailed "1"
    StrCpy $DownloadAttempts 3
    ${NSD_SetText} $DownloadStatus "The downloaded file was empty, so it was deleted. Nothing was changed."
    Call ShowDownloadFallback
    Abort
  ${EndIf}
  ${NSD_SetText} $DownloadStatus "Checking the file…"
  ; The digest is compared by the bundled helper, which exits 0 on a match.
  nsExec::ExecToStack '"$PLUGINSDIR\password-check.exe" --sha256 "${VCREDIST_SHA256}" "$PLUGINSDIR\vc_redist.x64.exe"'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    Delete "$PLUGINSDIR\vc_redist.x64.exe"
    StrCpy $DownloadFailed "1"
    ; A checksum mismatch is not a flaky line — the file that arrived is wrong. Stop offering Retry so the same
    ; wrong file is not fetched a fourth time, and say plainly that nothing was run.
    StrCpy $DownloadAttempts 3
    ${NSD_SetText} $DownloadStatus "The downloaded file was not the one ${PRODUCT_NAME} expects, so it was deleted and not run. Nothing was changed."
    Call ShowDownloadFallback
    Abort
  ${EndIf}
  ${NSD_SetText} $DownloadStatus "The file is verified."
FunctionEnd

; ===================================================================================== page 7: install
Section "Install"
  Call InstallPrerequisites
  Call InstallApplication
  Call ConfigureFirewall
  Call ConfigureStartup
SectionEnd

Function InstallPrerequisites
  ${If} $NeedsVcRuntime != "1"
    Return
  ${EndIf}

  ${If} ${INFOPLEX_OFFLINE} == 1
    File /oname=$PLUGINSDIR\vc_redist.x64.exe "${PREREQUISITE_VCREDIST}"
  ${EndIf}
  ${IfNot} ${FileExists} "$PLUGINSDIR\vc_redist.x64.exe"
    DetailPrint "The runtime file is missing; skipping it. Infoflex will ask for it when needed."
    Return
  ${EndIf}

  DetailPrint "Installing the Microsoft Visual C++ runtime."
  ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart' $PrereqExitCode

  ${If} $PrereqExitCode == "3010"
    MessageBox MB_ICONINFORMATION|MB_OK "Windows needs to restart to finish installing a component. You can restart now, or later and run ${PRODUCT_NAME} Setup again — your currency choice is kept." IDOK +2
    SetRebootFlag true
  ${EndIf}
FunctionEnd

Function InstallApplication
  WriteRegStr HKLM "Software\Infoflex" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\Infoflex" "CurrencyCode" "$CurrencyCodeOut"
  WriteRegStr HKLM "Software\Infoflex" "KeepInTray" "$TrayWanted"
  WriteUninstaller "$INSTDIR\Uninstall ${PRODUCT_NAME}.exe"

  ; The install-config the app reads at first run. ONLY on a fresh install: an update or a repair must never
  ; rewrite a working shop's currency.
  ${If} $WasInstalled == "0"
    ReadEnvStr $0 "ProgramData"
    ${If} $0 == ""
      StrCpy $0 "C:\ProgramData"
    ${EndIf}
    CreateDirectory "$0\${INSTALLER_CONFIG_DIR}"
    FileOpen $1 "$0\${INSTALLER_CONFIG_DIR}\${INSTALLER_CONFIG_FILE}" w
    ${If} $1 != ""
      FileWrite $1 "{$\r$\n"
      FileWrite $1 "  $\"format$\": $\"infoflex-install-config$\",$\r$\n"
      FileWrite $1 "  $\"version$\": 1,$\r$\n"
      FileWrite $1 "  $\"writtenAt$\": $\"$\",$\r$\n"
      ${If} ${INFOPLEX_OFFLINE} == 1
        FileWrite $1 "  $\"installerKind$\": $\"offline$\",$\r$\n"
      ${Else}
        FileWrite $1 "  $\"installerKind$\": $\"online$\",$\r$\n"
      ${EndIf}
      FileWrite $1 "  $\"appVersion$\": $\"${APP_VERSION}$\",$\r$\n"
      FileWrite $1 "  $\"currency$\": {$\r$\n"
      FileWrite $1 "    $\"code$\": $\"$CurrencyCodeOut$\",$\r$\n"
      FileWrite $1 "    $\"name$\": $\"$CurrencyNameOut$\",$\r$\n"
      FileWrite $1 "    $\"symbol$\": $\"$CurrencySymbolOut$\",$\r$\n"
      FileWrite $1 "    $\"decimalPlaces$\": $CurrencyDecimalsOut,$\r$\n"
      FileWrite $1 "    $\"symbolPosition$\": $\"$CurrencyPositionOut$\",$\r$\n"
      FileWrite $1 "    $\"thousandsSeparator$\": $\"$CurrencyThousandsOut$\",$\r$\n"
      FileWrite $1 "    $\"decimalSeparator$\": $\"$CurrencyDecimalOut$\",$\r$\n"
      ${If} $CurrencyIsCustom == "1"
        FileWrite $1 "    $\"isCustom$\": true$\r$\n"
      ${Else}
        FileWrite $1 "    $\"isCustom$\": false$\r$\n"
      ${EndIf}
      FileWrite $1 "  }$\r$\n"
      FileWrite $1 "}$\r$\n"
      FileClose $1
    ${EndIf}
  ${EndIf}

  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_NAME}.exe"
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_NAME}.exe"
FunctionEnd

Function ConfigureFirewall
  ${If} $FirewallWanted != "1"
    Return
  ${EndIf}
  ; One inbound rule, TCP, PRIVATE profile only. The app can also repair this from Mobile Access.
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Infoflex Mobile Access"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Infoflex Mobile Access" dir=in action=allow protocol=TCP localport=${MOBILE_PORT} profile=private description="Allows the Admin phone to reach Infoflex on this private network only."'
FunctionEnd

Function ConfigureStartup
  ${If} $StartupWanted == "1"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}" '"$INSTDIR\${PRODUCT_NAME}.exe" --hidden'
  ${Else}
    DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"
  ${EndIf}
FunctionEnd

; =================================================================================== uninstall
Function un.onInit
  ; The brief: "Keep my data?" defaults to yes. The database, the licence, the paired phones and the currency
  ; live in the app's data folder, which this uninstaller does not touch unless the customer says so.
  MessageBox MB_YESNO|MB_ICONQUESTION "Keep your shop data (products, sales, users, licence and currency)?$\r$\n$\r$\nChoose Yes to keep everything and remove only the program — this is safe and is what you want if you may reinstall. Choose No to remove the program AND all shop data." IDYES KeepData
    RMDir /r "$APPDATA\Infoflex"
    RMDir /r "$LOCALAPPDATA\Infoflex"
  KeepData:
FunctionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}.lnk"
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Infoflex Mobile Access"'
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"
  DeleteRegKey HKLM "Software\Infoflex"
  ; install-config.json is left in place on purpose: reinstalling must not silently re-choose the money if the
  ; data folder was kept.
  RMDir /r "$INSTDIR"
SectionEnd

; ================================================================================== tracing
Function .onInstFailed
  MessageBox MB_ICONSTOP|MB_OK "${PRODUCT_NAME} was not installed. Nothing on this computer was changed beyond what the log records.$\r$\n$\r$\nThe log is $INSTDIR\install.log."
FunctionEnd
