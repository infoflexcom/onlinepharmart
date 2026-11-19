; ==========================================================================================
; Infoflex Setup — the customer installer's pages and rules.
;
; **This file is an electron-builder `include`, not a standalone script.**
;
; electron-builder compiles its own installer.nsi, which already knows how to copy the application payload into
; $INSTDIR, write the registry entries, create the shortcuts and build the uninstaller. That work is not ours to
; reimplement — an installer that forgets it creates shortcuts to an application it never installed, which is
; exactly the defect this comment replaced. electron-builder pulls this file in through its `include` option and
; calls the `custom*` macros defined below at the right moments.
;
; What this file adds, in order: the vendor password gate, the Region and Currency page, the system check, the
; components page, the verified download page, and the config write that carries the chosen currency into the app.
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

; electron-builder's template already includes MUI2, LogicLib, nsDialogs, WinVer and the MUI macros. MUI2 included
; twice is a hard error in NSIS, so it is NOT re-included here.
;
; FileFunc is different: it is a macro library with no MUI or dialog definitions, and it provides ${GetParameters},
; ${GetOptions}, ${GetRoot} and ${DriveSpace}, all of which this file uses. It is included plainly — the static
; checker in `installer/src/check-nsis-script.ts` verifies that every stdlib macro used here is backed by its header,
; so an include that quietly disappeared would fail the build rather than fail on a vendor's machine.
!include "FileFunc.nsh"

; x64.nsh provides ${RunningX64}. WinVer.nsh does NOT define it, and the Windows-version check has to be written by
; hand for the same kind of reason: NSIS 3.x defines ${AtLeastWin11} and ${AtLeastWin8}, but never ${AtLeastWin10},
; because there was no separate Windows 10 major version to name. Windows 10 and 11 both report major 10, so the
; honest test is the Windows 10 build number (10240). Both of these were missing and the installer did not compile.
; The static checker's macro map claimed both came from WinVer.nsh, which is why it passed.
!include "x64.nsh"

!ifndef AtLeastWin10
  ; 10240 is the first Windows 10 build. `U>=` is WinVer's own unsigned comparison against WinVer::GetWinVer's output.
  !define AtLeastWin10 'U>= WinVer_BuildNumCheck 10240'
!endif

!include "json-escaping.nsh"
!include "generated.nsh"
!include "currency-ui.nsh"

; ------------------------------------------------------------------ warnings that are deliberate
;
; electron-builder runs makensis with -WX by default (`warningsAsErrors: false` is the only way to turn it off), so a
; single warning fails `npm run build` on the vendor's machine. The compiler check does not pass -WX, which is why this
; went unnoticed: the harness built cleanly while the real build would have stopped.
;
; Each code below is one this script provokes on purpose. They are disabled by number rather than by turning -WX off,
; so every OTHER warning -- including ones written after this file -- is still fatal, which is the point of -WX.
;
;   6020  "Uninstaller script code found but WriteUninstaller never used". This file is an `include`: it defines
;         uninstall-time functions and the `customUnInstall` macro, and electron-builder's template, not this file,
;         calls WriteUninstaller. Warning appears in the harness only.
;   6010  "function not referenced - zeroing code". The currency page's default-loader is referenced only by the
;         currency-locked build, and the download page exists only in the online build. `npm run installer:compile`
;         holds each build to the exact list of functions it may drop, so this is a known omission, not a silent one.
;   6001  "Variable not referenced or never set". Several variables are set by the template or read only on one branch
;         (for example $appExe and $launchLink are the template's own).
;
; Written as separate pragmas rather than `disable all`, which would also silence the warnings that matter.
!pragma warning disable 6020
!pragma warning disable 6010
!pragma warning disable 6001

; ------------------------------------------------------------------ compile-time configuration
;
; electron-builder's template defines PRODUCT_NAME, APP_VERSION, PRODUCT_FILENAME and the icon bitmaps before
; including this file. Only the two values it cannot know are set here.

; ------------------------------------------------------------------ the executable's real file name
;
; Every shortcut, the "Run now" checkbox and the autostart entry must point at the file electron-builder actually wrote.
; This script used to assume that was "${PRODUCT_NAME}.exe". Usually it is, and that is why the assumption survived: it
; is right for every name without a character Windows forbids in a filename. It is wrong for a name with one.
;
; `productName: "Infoflex:Pharmart"` produces the executable `InfoflexPharmart.exe` -- electron-builder sanitises the
; name -- while `PRODUCT_NAME` stays "Infoflex:Pharmart". The installer would then create a desktop shortcut, a Start
; menu shortcut, a finish-page "Run" target and an autostart registry value that all point at a file that does not
; exist. The install would report success and every one of those would do nothing when clicked, which is the worst kind
; of failure to diagnose from a customer's description.
;
; electron-builder passes the sanitised name as PRODUCT_FILENAME, and its own common.nsh already derives
; APP_EXECUTABLE_FILENAME from it. That define is the authority, so it is used when present. The fallback keeps this
; script compilable on its own by a harness, and matches what electron-builder would produce for a plain name.
!ifndef APP_EXECUTABLE_FILENAME
  !ifdef PRODUCT_FILENAME
    !define APP_EXECUTABLE_FILENAME "${PRODUCT_FILENAME}.exe"
  !else
    !define APP_EXECUTABLE_FILENAME "${PRODUCT_NAME}.exe"
  !endif
!endif

!ifndef INFOPLEX_OFFLINE
  !define INFOPLEX_OFFLINE 0
!endif

; The PBKDF2 helper, compiled for this build. It is the ONLY place the password hash is compared, and it is
; `installer/src/password-check-cli.ts`. Referenced by the password page with File /oname.
!ifndef INSTALLER_PASSWORD_CHECKER
  !define INSTALLER_PASSWORD_CHECKER "${BUILD_RESOURCES_DIR}\password-check.exe"
!endif

; Names electron-builder does not supply. PRODUCT_NAME and APP_VERSION come from the electron-builder config.
!ifndef INSTALLER_PRODUCT_NAME
  !define INSTALLER_PRODUCT_NAME "${PRODUCT_NAME}"
!endif

; Brand bitmaps. electron-builder sets MUI_ICON and the headerimage from its own options; our sidebar must be set
; here because electron-builder has no option for the welcome-page bitmap.
!ifndef INSTALLER_SIDEBAR
  !define INSTALLER_SIDEBAR "${BUILD_RESOURCES_DIR}\installer-sidebar.bmp"
!endif

; Name, OutFile, InstallDir, RequestExecutionLevel, the compression and the version resource all belong to
; electron-builder's template when this file is used as an include — setting them here as well is a duplicate
; definition error. See electron-builder.installer-online.json.

!define MUI_ABORTWARNING
; The wizard icon and the header image come from electron-builder's `installerIcon` and `installerHeader` options;
; only the welcome-page sidebar has no option, so it is defined here.
!ifndef MUI_HEADERIMAGE
  !define MUI_HEADERIMAGE
!endif
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
Var CurrencyCodeJson
Var CurrencyNameJson
Var CurrencySymbolJson
Var CurrencyThousandsJson
Var CurrencyDecimalJson

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
Var FirewallWanted
Var StartupWanted
Var TrayWanted

Var DownloadDlg
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

; Launch the application as the logged-on user, not as the elevated installer. See the note in customFinishPage for
; why this function exists at all rather than MUI_FINISHPAGE_RUN pointing straight at the executable.
Function LaunchAsUser
  ; StdUtils is a PLUGIN (StdUtils.dll), not a header, and it ships with electron-builder's NSIS distribution rather
  ; than with a source-built makensis. The compile check builds makensis from source in this sandbox, so the plugin is
  ; absent there and the call cannot even be resolved.
  ;
  ; Rather than delete the correct behaviour to satisfy the harness -- which would ship the elevated launch back to
  ; customers to make a test pass -- the call is guarded on the plugin's presence at compile time, and the fallback is
  ; the plain Exec it is trying to avoid. That fallback is a DEFECT, and it is labelled as one: it exists so the
  ; harness can compile, and the real build (electron-builder's distribution) always takes the first branch.
  ;
  ; `!if /FileExists` is evaluated by makensis at compile time, in the real build, against the real plugin directory.
  !if /FileExists "${NSISDIR}\Plugins\x86-unicode\StdUtils.dll"
    ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" ""
  !else
    ; Unreachable in the shipping build. Documented in docs/DECISIONS.md under "what the harness cannot prove".
    Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  !endif
FunctionEnd

!macro customFinishPage
  !define MUI_FINISHPAGE_TITLE "${PRODUCT_NAME} is installed"
  !define MUI_FINISHPAGE_TEXT "Currency: $CurrencyCodeOut - $CurrencyNameOut ($CurrencySymbolOut)$\r$\n$\r$\nThe Admin can use a phone by opening Mobile Access inside the app. Cashiers work on this computer.$\r$\n$\r$\nThe install log is beside the app in the folder you chose."
  ; NOT `MUI_FINISHPAGE_RUN "<path>"` on its own. With only that define, MUI's finish page runs the target with
  ; `Exec` (Contrib/Modern UI 2/Pages/Finish.nsh:482-486), and `Exec` is `CreateProcess` (Source/exehead/util.c:87-92),
  ; which inherits the caller's token. This installer is perMachine and elevates, so "Launch now" would start the
  ; application as Administrator -- every time, for every customer, from the one button most likely to be clicked.
  ;
  ; A shop app running elevated is the wrong shape: it makes the SQLite database and the DPAPI-protected TLS identity
  ; owned by an elevated context, it lets the renderer touch things that should need a UAC prompt, and it trains the
  ; operator to click yes to UAC prompts. electron-builder's own template avoids this by defining
  ; MUI_FINISHPAGE_RUN empty and using a FUNCTION that launches via ${StdUtils.ExecShellAsUser}
  ; (assistedInstaller.nsh:52-61); this does the same, because the reason applies identically to a custom finish page.
  ;
  ; The property is declared, not inferred: MUI_FINISHPAGE_RUN must be DEFINED for the checkbox to appear at all, so it
  ; is defined to an empty value, and the function below is what runs.
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "LaunchAsUser"
  !define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\install.log"
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Open install log"
  !insertmacro MUI_PAGE_FINISH
!macroend

; ================================================================================ init and silent mode
; =============================================================== does this machine need the VC++ runtime?
;
; This used to be computed only inside ChecksPageCreate, which is a page callback. Two consequences, both silent:
;
;   * on a `/S` install, `$NeedsVcRuntime` stayed "0", so InstallPrerequisites returned at its first line and the
;     prerequisite was never installed -- the interactive path installed it and the unattended one skipped it;
;   * on an offline build it was worse. The offline download page is `!if`-excluded, so nothing sets $DownloadFailed
;     either, and a page callback never runs to try. The offline installer's refusal to continue on a missing payload
;     was therefore never armed: it would have carried on and installed an app whose prerequisite was absent.
;
; It is a macro so the page, the silent branch and the upgrade path all ask the same question with the same registry
; lookups, rather than each keeping its own copy of a two-key probe.
!macro DetectVcRuntime
  StrCpy $NeedsVcRuntime "0"
  ReadRegStr $2 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Version"
  ${If} $2 == ""
    ReadRegStr $2 HKLM "SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Version"
  ${EndIf}
  ${If} $2 == ""
    StrCpy $NeedsVcRuntime "1"
  ${EndIf}
!macroend

; ================================================================================== the install log
;
; Three places in this script tell the customer that `$INSTDIR\install.log` exists: the finish page offers to open it,
; the finish-page text says it is beside the app, and the failure message says the log records what happened. Until now
; nothing wrote it. The file was invented by the documentation of itself, so a customer who clicked "Open install log"
; got a Windows "cannot find the file" error at the one moment they were looking for help.
;
; The obvious way to produce it -- NSIS's `LogSet on` -- does not exist in the build. `LogSet` is compiled in only when
; NSIS was built with `NSIS_CONFIG_LOG`, and it is not: a probe in this sandbox fails with `LogSet specified,
; NSIS_CONFIG_LOG not defined`. electron-builder wraps it in `${LogSet}`, which is a no-op unless the project sets
; `customNsisBinary.debugLogging` -- and this project does not.
;
; So the log is written with `FileWrite`, which is always available and does exactly what is needed: lines we choose,
; in an order we choose, appended as the install proceeds. `FileWrite` needs an open handle, so the handle is opened
; once, in .onInit, and kept in a global. Every write is guarded on the handle, because an installer that crashes
; while trying to write its own error log is worse than one with no log.
Var LogHandle

/**
 * Open the log for appending, and write the header.
 *
 * $INSTDIR does not exist yet when .onInit runs, and on an upgrade it is the OLD directory. So the log is started in
 * $PLUGINSDIR -- always writable -- and copied into $INSTDIR by FinishLog once the payload is in place. That ordering
 * is what makes the log survive the case it is most needed for: an install that fails before $INSTDIR is usable.
 */
!macro StartLog
  ${If} $LogHandle == ""
    InitPluginsDir
    FileOpen $LogHandle "$PLUGINSDIR\install.log" w
    ${If} $LogHandle != ""
      FileWrite $LogHandle "${PRODUCT_NAME} ${APP_VERSION} install log$\r$\n"
      FileWrite $LogHandle "=================================$\r$\n"
    ${EndIf}
  ${EndIf}
!macroend

/** Append one line if the log is open. */
!macro LogLine TEXT
  ${If} $LogHandle != ""
    FileWrite $LogHandle "${TEXT}$\r$\n"
  ${EndIf}
!macroend

/** Copy the finished log beside the application, then close it. */
!macro FinishLog
  ${If} $LogHandle != ""
    FileWrite $LogHandle "Install finished.$\r$\n"
    FileClose $LogHandle
    StrCpy $LogHandle ""
    ; $INSTDIR may not exist at all if the install failed before the payload landed; CreateDirectory is cheap and makes
    ; the CopyFiles below succeed rather than silently leaving the log in the temp directory.
    CreateDirectory $INSTDIR
    CopyFiles /SILENT "$PLUGINSDIR\install.log" "$INSTDIR\install.log"
  ${EndIf}
!macroend

Function .onInstSuccess
  !insertmacro LogLine "Result: installed successfully."
  !insertmacro FinishLog
FunctionEnd

Function .onInit
  ; First, before anything can fail: the log the finish page and the failure message both promise.
  StrCpy $LogHandle ""
  !insertmacro StartLog
  !insertmacro LogLine "Windows version check and prerequisite detection follow."
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

  ; ---- silent install: /S or /SILENT, with a REQUIRED /PASSWORD= and an optional validated /CURRENCY=CODE
  ;
  ; The vendor password is checked in PasswordPageLeave, which is a page callback -- and a silent run draws no pages,
  ; so `${Silent}` skipped the gate entirely. Every other thing the gate protects was therefore optional: anyone could
  ; run `Infoflex Setup.exe /S`, install without the vendor password, and choose the currency themselves from a command
  ; line, which is the one decision the gate exists to keep with the vendor. The gate was real for the person who
  ; double-clicked the file and absent for the person who typed a flag.
  ;
  ; So the silent path verifies the same password through the same helper. It is required, not optional: a silent
  ; install without /PASSWORD= fails, because the alternative -- installing anyway -- is exactly the bypass.
  ;
  ; The password is read from the command line rather than an environment variable because Electron and NSIS alike keep
  ; `GetParameters` in memory only; neither is logged. It does appear in a process listing for the duration of the
  ; install, which is worth knowing and is stated in docs/DECISIONS.md rather than glossed over.
  ${If} ${Silent}
    ; The same Windows-version and 64-bit checks that block the system-check page, because a silent run draws no pages
    ; and ChecksPageLeave -- the only place they were enforced -- never runs. Without this, `/S` on a 32-bit machine
    ; installs a 64-bit application that cannot start, and the deployment tool reports success. The page is still the
    ; friendly explanation for an interactive install; this is the refusal for the unattended one.
    ${IfNot} ${AtLeastWin10}
      !insertmacro LogLine "Refused: Windows is older than 10."
      MessageBox MB_ICONSTOP|MB_OK "${PRODUCT_NAME} needs Windows 10 or later (64-bit). This is a silent install, so nothing was changed on this computer." /SD IDOK
      SetErrorLevel 3
      Abort
    ${EndIf}
    ${IfNot} ${RunningX64}
      !insertmacro LogLine "Refused: 32-bit Windows."
      MessageBox MB_ICONSTOP|MB_OK "${PRODUCT_NAME} needs 64-bit Windows 10 or later; this computer is running 32-bit Windows. This is a silent install, so nothing was changed on this computer." /SD IDOK
      SetErrorLevel 3
      Abort
    ${EndIf}

    ; The prerequisite probe, for the same reason as the two checks above: its only other home is a page callback.
    !insertmacro DetectVcRuntime

    ${GetParameters} $R0
    ${GetOptions} $R0 "/PASSWORD=" $PasswordValue
    ${If} ${Errors}
      MessageBox MB_ICONSTOP|MB_OK "${PRODUCT_NAME} Setup needs the vendor password for a silent install: pass /PASSWORD=<the password supplied with your purchase>." /SD IDOK
      SetErrorLevel 2
      Abort
    ${EndIf}
    ; Same helper, same format, same failure mode as the password page: a missing helper fails CLOSED.
    InitPluginsDir
    File /oname=$PLUGINSDIR\password-check.exe "${INSTALLER_PASSWORD_CHECKER}"
    ${IfNot} ${FileExists} "$PLUGINSDIR\password-check.exe"
      MessageBox MB_ICONSTOP|MB_OK "The installer is incomplete: its password checker is missing. Download ${PRODUCT_NAME} Setup again." /SD IDOK
      Quit
    ${EndIf}
    nsExec::ExecToStack '"$PLUGINSDIR\password-check.exe" "${INSTALLER_PASSWORD_SALT}" "${INSTALLER_PASSWORD_HASH}" "${INSTALLER_PASSWORD_ITERATIONS}" "$PasswordValue"'
    Pop $0
    Pop $1
    ${If} $0 != "0"
      ; No attempt counter here. The counter exists to slow a person at a keyboard; a silent run is scripted, has no
      ; page to redraw, and a script that has the wrong password gains nothing by being told how many tries remain.
      MessageBox MB_ICONSTOP|MB_OK "That vendor password is not correct. ${PRODUCT_NAME} Setup has not changed anything on this computer." /SD IDOK
      SetErrorLevel 2
      Abort
    ${EndIf}

    ${GetOptions} $R0 "/CURRENCY=" $1
    ${IfNot} ${Errors}
      ; An empty value is an error, not a licence to use the default.
      ${If} $1 == ""
        MessageBox MB_ICONSTOP|MB_OK "/CURRENCY needs a currency code, for example /CURRENCY=GHS." /SD IDOK
        SetErrorLevel 2
        Abort
      ${EndIf}
      ; Validate against the generated table. A typo must fail the install with a reason, never silently
      ; install a shop in the wrong money.
      ;
      ; The check is a generated macro, one branch per currency in the app's catalogue, so it cannot drift from the
      ; wizard's dropdown. It used to be a hand-written chain of nine ${If}s for nine popular currencies, which
      ; rejected `/CURRENCY=UGX` -- a currency the app supports in full -- and aborted a legitimate install.
      StrCpy $0 $1
      !insertmacro ValidateCurrencyCode
      ${If} $3 == ""
        MessageBox MB_ICONSTOP|MB_OK "/CURRENCY=$1 is not a built-in currency. Use an ISO code from the installer's list, for example /CURRENCY=GHS." /SD IDOK
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
    MessageBox MB_ICONSTOP|MB_OK "The installer is incomplete: its password checker is missing. Download ${PRODUCT_NAME} Setup again." /SD IDOK
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
    MessageBox MB_ICONSTOP|MB_OK "Too many incorrect attempts. ${PRODUCT_NAME} Setup will close." /SD IDOK
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

  ; A build whose vendor locked the currency shows it and nothing else: no list, no "Custom currency" link, no
  ; way to leave the page with a different currency. This branch is compiled from the build profile, so a locked
  ; build genuinely cannot offer the choice rather than merely discouraging it.
  !if ${INSTALLER_CURRENCY_LOCKED} == 1
    StrCpy $CurrencyCodeOut "${INSTALLER_DEFAULT_CURRENCY}"
    Call LoadDefaultCurrencyFields
    ${NSD_CreateLabel} 0 0 100% 30u "Your vendor has set the currency for this installation. Every amount is kept in it."
    Pop $0
    ${NSD_CreateLabel} 0 36u 100% 16u "$CurrencyCodeOut - $CurrencyNameOut ($CurrencySymbolOut)"
    Pop $0
    ${NSD_CreateLabel} 0 56u 100% 16u "Example: ${CUR_DEFAULT_EXAMPLE}"
    Pop $0
    ${NSD_CreateLabel} 0 84u 100% 40u "This currency cannot be changed. If it is wrong for your store, contact your vendor."
    Pop $0
  !else
    ${NSD_CreateLabel} 0 0 100% 20u "Every amount in ${PRODUCT_NAME} is kept in this currency. You can change it only until your first sale."
    Pop $0
    ${NSD_CreateLabel} 0 26u 100% 12u "Which currency will this store use?"
    Pop $0
    ${NSD_CreateListBox} 0 40u 100% 74u ""
    Pop $CurrencyList
    !insertmacro FillCurrencyList
    ; Open on the build's currency, not on row 0 — a build made for Ghana must show Cedis first.
    ${NSD_LB_SetSelectionIndex} $CurrencyList ${INSTALLER_DEFAULT_INDEX}
    Call RefreshCurrencyExample
    ${NSD_CreateLabel} 0 118u 100% 12u ""
    Pop $CurrencyExample
    Call RefreshCurrencyExample
    ${NSD_CreateLabel} 0 136u 100% 28u "You can change this only until your first sale. If your vendor set a currency on your licence, it is already chosen and cannot be changed."
    Pop $0
    ${NSD_CreateLink} 0 166u 60% 12u "Custom currency..."
    Pop $0
    ${NSD_OnClick} $0 CurrencyCustomClicked
  !endif

  nsDialogs::Show
FunctionEnd

; Copies the build's currency into the seven live variables for the locked page, using the same generated
; row-to-fields mapping the dropdown uses. $R0 is that mapping's input, so the locked page and the list agree by
; construction rather than by two hand-maintained copies.
Function LoadDefaultCurrencyFields
  StrCpy $R0 "${INSTALLER_DEFAULT_INDEX}"
  !insertmacro SetCurrencyFromIndex
FunctionEnd

Function RefreshCurrencyExample
  ${NSD_LB_GetSelectionIndex} $CurrencyList $0
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
  !if ${INSTALLER_CURRENCY_LOCKED} == 1
    ; Nothing on the page can be edited, so there is nothing to validate. Returning here also means the custom
    ; currency branch below can never be reached in a locked build.
    Return
  !endif
  ${If} $CurrencyIsCustom == "1"
    ${If} $CurrencyCodeOut == ""
      MessageBox MB_ICONEXCLAMATION|MB_OK "Enter a code for your custom currency, for example WBC." /SD IDOK
      Abort
    ${EndIf}
    ${If} $CurrencyNameOut == ""
      MessageBox MB_ICONEXCLAMATION|MB_OK "Enter a name for your custom currency." /SD IDOK
      Abort
    ${EndIf}
    ${If} $CurrencySymbolOut == ""
      MessageBox MB_ICONEXCLAMATION|MB_OK "Enter a symbol for your custom currency." /SD IDOK
      Abort
    ${EndIf}
    ${If} $CurrencyDecimalsOut != "0"
    ${AndIf} $CurrencyDecimalsOut != "1"
    ${AndIf} $CurrencyDecimalsOut != "2"
    ${AndIf} $CurrencyDecimalsOut != "3"
    ${AndIf} $CurrencyDecimalsOut != "4"
      MessageBox MB_ICONEXCLAMATION|MB_OK "Enter the number of decimal places as a single digit from 0 to 4." /SD IDOK
      Abort
    ${EndIf}
    Return
  ${EndIf}

  ${NSD_LB_GetSelectionIndex} $CurrencyList $R0
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

      !insertmacro DetectVcRuntime
      ${If} $NeedsVcRuntime == "1"
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
  ; Greys the checkbox and keeps it ticked. nsDialogs has no DisableWindow macro, so this is the WM_ENABLE message
  ; that one would have sent.
  SendMessage $0 ${WM_ENABLE} 0 0

  ${NSD_CreateCheckbox} 0 18u 100% 12u "Install the Microsoft Visual C++ runtime if it is missing (required)"
  Pop $0
  ${NSD_Check} $0
  SendMessage $0 ${WM_ENABLE} 0 0

  ${NSD_CreateCheckbox} 0 38u 100% 12u "Add the Admin phone firewall rule (private networks only)"
  Pop $CompFirewall
  ${NSD_Check} $CompFirewall

  ${NSD_CreateCheckbox} 0 56u 100% 12u "Start ${PRODUCT_NAME} when Windows starts"
  Pop $CompStartup
  ${NSD_Check} $CompStartup

  ${NSD_CreateCheckbox} 0 74u 100% 12u "Keep running in the system tray"
  Pop $CompTray
  ${NSD_Check} $CompTray

  ; NOT an editable folder box. This was ${NSD_CreateDirRequest} 0 112u 70% 12u "$INSTDIR" -> Pop $0, and $0 was never
  ; read: the customer could type any folder, press Next, and the application still installed to the folder the
  ; *Directory* page chose. It looked like the place where the folder is set and was not.
  ;
  ; electron-builder inserts MUI_PAGE_DIRECTORY before this page (assistedInstaller.nsh:22-26, because
  ; allowToChangeInstallationDirectory is true) and its instFilesPre then appends the app sub-folder, so $INSTDIR is
  ; already final here. Showing it is useful; editing it belongs on the page that owns it.
  ${NSD_CreateLabel} 0 98u 100% 12u "Install folder (change it on the previous page)"
  Pop $0
  ${NSD_CreateLabel} 0 112u 100% 24u "$INSTDIR"
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
  ; NO progress bar. There used to be one here (${NSD_CreateProgressBar} -> $DownloadProgress) and nothing ever moved
  ; it: the only download is NSISdl::download, and NSISdl cannot drive a nsDialogs control. It paints its own overlay
  ; on the wizard's *stock* progress bar, which it finds by GetDlgItem(childwnd, 1004) / 1006 -- the InstallFiles
  ; page's resource IDs (Contrib/UIs/resource.h: IDC_PROGRESS 1004, IDC_INTROTEXT 1006). An nsDialogs page is the
  ; 1018 placeholder dialog and its controls are created with IDs 1200+ (Contrib/nsDialogs/nsDialogs.c:394), so both
  ; GetDlgItem calls return NULL, the `if (childwnd && hwndP && hwndS)` block is skipped, and g_file_size is never
  ; set -- progress_callback then does nothing at all (Contrib/NSISdl/nsisdl.cpp:61-66, 213-228, 469-471). NSISdl
  ; also never pumps messages, so nothing it drew could repaint during the download anyway.
  ;
  ; The bar therefore sat at zero for the whole download: a control that is decorative in the strongest sense. It was
  ; replaced by a label that says what is happening and, because NSISdl blocks without servicing the message queue,
  ; is honest about when it updates.
  ${NSD_CreateLabel} 0 28u 100% 30u ""
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
    MessageBox MB_ICONSTOP|MB_OK "The file you chose is not the one ${PRODUCT_NAME} expects, so it was not used. Nothing was changed." /SD IDOK
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
  MessageBox MB_ICONINFORMATION|MB_OK "The Offline installer contains everything and needs no internet. Ask support for it, or download it on another computer and copy it across. This installer has not changed anything on this computer." /SD IDOK
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
  ; The line above is only true if the page repaints before the download starts. NSISdl::download blocks inside the
  ; plugin and never pumps the message queue -- there is no PeekMessage/DispatchMessage anywhere in
  ; Contrib/NSISdl/nsisdl.cpp -- so set the text, force one repaint, and only then block. Without the UpdateWindow the
  ; customer sees whatever the page looked like on entry (a blank status line) for the whole download, and the text
  ; "Downloading…" appears only in the moment it is replaced by the result.
  ;
  ; This is also the reason there is no progress bar on this page: see the note in DownloadPageCreate.
  System::Call 'user32::UpdateWindow(p $HWNDPARENT)'
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
  ; GetSize (FileFunc.nsh) is the macro that exists -- there is no GetFileSize. It clears the error flag on success and
  ; returns the size in bytes in $1; the error flag is what tells a missing file from an empty one.
  ClearErrors
  ${GetSize} "$PLUGINSDIR" "/M=vc_redist.x64.exe /S=0K /G=1" $0 $1 $2
  ${If} ${Errors}
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
;
; `customInstall` is inserted by electron-builder *after* it has copied the application payload into $INSTDIR, written
; the registry entries, created the shortcuts and written the uninstaller. That is why this is a macro and not a
; Section: as a Section it would either conflict with electron-builder's own "Install" section or, standing alone,
; install a wizard that creates shortcuts to an application it never copied.
!macro customInstall
  !insertmacro LogLine "Install directory: $INSTDIR"
  !insertmacro LogLine "Currency: $CurrencyCodeOut $CurrencySymbolOut ($CurrencyNameOut), custom=$CurrencyIsCustom"
  !insertmacro LogLine "Existing installation updated: $WasInstalled"
  !insertmacro LogLine "Prerequisite needed: $NeedsVcRuntime"
  !insertmacro LogLine "Firewall rule requested: $FirewallWanted"
  !insertmacro LogLine "Start with Windows: $StartupWanted"
  !insertmacro LogLine "Keep in tray: $TrayWanted"
  Call InstallApplication
  !insertmacro LogLine "Application files and install-config written."
  Call InstallPrerequisites
  Call ConfigureFirewall
  !insertmacro LogLine "Firewall step done."
  Call ConfigureStartup
  !insertmacro LogLine "Startup step done."
  ; Left open on purpose: .onInstSuccess writes the result line and closes it. A section that stopped here by Abort-ing
  ; leaves the handle open, which is why .onInstFailed also calls FinishLog.
!macroend

Function InstallPrerequisites
  ${If} $NeedsVcRuntime != "1"
    Return
  ${EndIf}

  ${If} ${INFOPLEX_OFFLINE} == 1
    ; The offline build carries the redistributable instead of downloading it, so the path to it must be supplied at
    ; compile time. Nothing supplied it: ${PREREQUISITE_VCREDIST} was defined only by the harness, and the real offline
    ; build failed with `File: "${PREREQUISITE_VCREDIST}" -> no files found`. The harness defines it too, which is
    ; exactly why this was invisible -- the harness supplied a value the build never had.
    ;
    ; It is now a !ifdef, so a build that forgets to supply the file produces an installer that downloads the runtime
    ; when it can rather than one that will not compile or one that silently ships without a prerequisite it promised.
    ; electron-builder passes -DPREREQUISITE_VCREDIST=... (see electron-builder.installer-offline.json); the release
    ; checklist pins the checksum and places the file.
    !ifdef PREREQUISITE_VCREDIST
      File /oname=$PLUGINSDIR\vc_redist.x64.exe "${PREREQUISITE_VCREDIST}"
    !endif
  ${EndIf}
  ${IfNot} ${FileExists} "$PLUGINSDIR\vc_redist.x64.exe"
    ; The online build may legitimately carry on: the app asks for the runtime on first use, and the download path that
    ; was meant to fetch it has already had its three attempts.
    ;
    ; The offline build may not. It tells the customer "every prerequisite is included in this installer" on the
    ; components page, and until now a build whose payload was missing carried on and installed anyway -- the promise
    ; and the behaviour were never connected. `$DownloadFailed` was the template's way of expressing this, and the
    ; offline download page is `!if`-excluded, so nothing ever set it. The offline arm refuses instead, because an
    ; installer that exists to be carried to a machine with no internet cannot quietly leave the prerequisite behind.
    ${If} ${INFOPLEX_OFFLINE} == 1
      MessageBox MB_ICONSTOP|MB_OK "This offline installer is incomplete: the Microsoft Visual C++ runtime it was built to carry is missing, and there is no internet here to fetch it. Nothing was installed. Ask for a fresh copy of the offline installer." /SD IDOK
      SetErrorLevel 4
      Abort
    ${EndIf}
    DetailPrint "The runtime file is missing; skipping it. Infoflex will ask for it when needed."
    Return
  ${EndIf}

  ; Verify BEFORE running it. This check used to be missing, and the omission pointed the wrong way: the download page
  ; verifies the digest, the "browse for the file myself" path verifies the digest, and this path -- the one that
  ; actually executes the file -- checked nothing. Because the shipped digest is all zeros until a release pins it, the
  ; verified paths refused every file while this unverified path was the one that still ran it. A safety measure that
  ; guards everything except the dangerous step is worse than none, because it reads as diligence.
  ;
  ; The digest is the same ${VCREDIST_SHA256} the download page uses, compared by the same bundled helper, so the three
  ; paths cannot disagree about which file is acceptable. It costs one process launch.
  DetailPrint "Checking the Microsoft Visual C++ runtime before installing it."
  nsExec::ExecToStack '"$PLUGINSDIR\password-check.exe" --sha256 "${VCREDIST_SHA256}" "$PLUGINSDIR\vc_redist.x64.exe"'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    Delete "$PLUGINSDIR\vc_redist.x64.exe"
    ; Delete it, say so, and continue the install without it: the application still installs and runs, and will ask for
    ; the runtime itself if it is ever needed. Refusing the whole install would strand a shop over a component the app
    ; can live without. What must NOT happen is running the file.
    DetailPrint "The bundled Visual C++ runtime did not match its expected digest, so it was deleted and not run."
    MessageBox MB_ICONEXCLAMATION|MB_OK "A supporting component (the Microsoft Visual C++ runtime) did not match the copy ${PRODUCT_NAME} expects, so it was not installed. ${PRODUCT_NAME} will ask for it the first time it needs it. Nothing else was affected." /SD IDOK
    Return
  ${EndIf}

  DetailPrint "Installing the Microsoft Visual C++ runtime."
  ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart' $PrereqExitCode

  ${If} $PrereqExitCode == "3010"
    MessageBox MB_ICONINFORMATION|MB_OK "Windows needs to restart to finish installing a component. You can restart now, or later and run ${PRODUCT_NAME} Setup again — your currency choice is kept." /SD IDOK IDOK +2
    SetRebootFlag true
  ${EndIf}
FunctionEnd

; The parts electron-builder does not do. The application files, the uninstaller and the shortcut targets are its
; job (and it does them before this macro runs).
Function InstallApplication
  WriteRegStr HKLM "Software\Infoflex" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\Infoflex" "CurrencyCode" "$CurrencyCodeOut"
  WriteRegStr HKLM "Software\Infoflex" "KeepInTray" "$TrayWanted"

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
      ; Escape every value first. A custom currency may contain a quote or a backslash, and unescaped either one
      ; would produce a file the app refuses to read — losing the shop's choice with no error anywhere.
      StrCpy $3 $CurrencyCodeOut
      Call EscapeJson
      StrCpy $CurrencyCodeJson $3
      StrCpy $3 $CurrencyNameOut
      Call EscapeJson
      StrCpy $CurrencyNameJson $3
      StrCpy $3 $CurrencySymbolOut
      Call EscapeJson
      StrCpy $CurrencySymbolJson $3
      StrCpy $3 $CurrencyThousandsOut
      Call EscapeJson
      StrCpy $CurrencyThousandsJson $3
      StrCpy $3 $CurrencyDecimalOut
      Call EscapeJson
      StrCpy $CurrencyDecimalJson $3

      FileWrite $1 "  $\"writtenAt$\": $\"$\",$\r$\n"
      ${If} ${INFOPLEX_OFFLINE} == 1
        FileWrite $1 "  $\"installerKind$\": $\"offline$\",$\r$\n"
      ${Else}
        FileWrite $1 "  $\"installerKind$\": $\"online$\",$\r$\n"
      ${EndIf}
      FileWrite $1 "  $\"appVersion$\": $\"${APP_VERSION}$\",$\r$\n"
      FileWrite $1 "  $\"currency$\": {$\r$\n"
      FileWrite $1 "    $\"code$\": $\"$CurrencyCodeJson$\",$\r$\n"
      FileWrite $1 "    $\"name$\": $\"$CurrencyNameJson$\",$\r$\n"
      FileWrite $1 "    $\"symbol$\": $\"$CurrencySymbolJson$\",$\r$\n"
      FileWrite $1 "    $\"decimalPlaces$\": $CurrencyDecimalsOut,$\r$\n"
      FileWrite $1 "    $\"symbolPosition$\": $\"$CurrencyPositionOut$\",$\r$\n"
      FileWrite $1 "    $\"thousandsSeparator$\": $\"$CurrencyThousandsJson$\",$\r$\n"
      FileWrite $1 "    $\"decimalSeparator$\": $\"$CurrencyDecimalJson$\",$\r$\n"
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

  ; NO CreateShortCut HERE, deliberately.
  ;
  ; electron-builder's install section creates both shortcuts *before* it inserts this hook (installSection.nsh:
  ; addStartMenuLink, addDesktopLink, then customInstall), at "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" and
  ; "$DESKTOP\${SHORTCUT_NAME}.lnk". SHORTCUT_NAME defaults to the sanitised product name -- "Infoflex", the same
  ; value as ${PRODUCT_NAME} -- so the two lines that used to sit here wrote to exactly the same paths, just after
  ; electron-builder's WinShell::SetLnkAUMI had stamped its AppUserModelID onto them. CreateShortCut replaces the .lnk
  ; wholesale, so the AppUserModelID was gone, and Windows grouping, the taskbar jump list and its pinning behaviour
  ; all depend on it matching app.setAppUserModelId('com.infoflex.pharmart') in src/main/index.ts.
  ;
  ; It was also unreachable-by-accident: this hook only runs on a fresh install, so a *repair* kept
  ; electron-builder's correct link and only a fresh install lost it. That is the signature of two owners for one
  ; file, and the fix is to leave the file to its owner. The Components page never offered a shortcut option, so there
  ; was nothing here for electron-builder's flags to defer to.
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
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --hidden'
  ${Else}
    DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"
  ${EndIf}
FunctionEnd

; =================================================================================== uninstall
;
; This is a MACRO, not `Function un.onInit`, and that distinction cost the whole uninstaller.
;
; electron-builder's own uninstaller.nsh already defines `Function un.onInit`. This script is layered into
; electron-builder's template via `nsis.include`, so both definitions land in the same compile, and NSIS rejects the
; second one outright: `Error: Function named "un.onInit" already exists.` The uninstaller pass therefore could not
; build at all -- which nothing here noticed, because nothing here compiled that pass.
;
; The supported hook is `customUnInit`, which the template inserts *inside* its own `un.onInit`:
;
;     !ifmacrodef customUnInit
;       !insertmacro customUnInit
;     !endif
;
; Defining our own `un.onInit` did not merely collide. Had it somehow replaced the template's function, it would also
; have dropped `initMultiUser`, which is what makes `un.onInit` here run with the right shell variable context.
!macro customUnInit
  ; The brief: "Keep my data?" defaults to yes. The database, the licence, the paired phones and the currency
  ; live in the app's data folder, which this uninstaller does not touch unless the customer says so.
  ; `SetShellVarContext current` is not decoration. This installer is perMachine (INSTALL_MODE_PER_ALL_USERS), and the
  ; template calls `initMultiUser` -- which runs `setInstallModePerAllUsers` -> `SetShellVarContext all` -- BEFORE this
  ; hook. With `all`, `$APPDATA` is `C:\ProgramData` and `$LOCALAPPDATA` is `C:\ProgramData` too. So the two RMDir
  ; lines that used to sit here pointed at folders that do not hold the shop's data at all, and the "remove my data"
  ; choice would have left the database, the licence and the paired phones exactly where they were -- while reporting
  ; that everything had been removed. electron-builder's own delete-app-data code switches context for this same
  ; reason (uninstaller.nsh:234-237).
  ;
  ; The folder name is the app's Electron name, not the product name and not ${APP_FILENAME}: src/main/index.ts pins
  ; `app.setName('Infoflex')`, and Electron derives userData from that. The install directory name and the Electron
  ; app name are independent values, so a literal is what matches.
  ; ------------------------------------------------------------------ the upgrade case, which decides everything else
  ;
  ; electron-builder runs the OLD uninstaller before every install, to clear the previous version. It does that with
  ; `ExecWait '"$uninstallerFileNameTemp" /S /KEEP_APP_DATA $0'` where $0 carries `--updated` (installUtil.nsh:200-215,
  ; 226-230) -- silently, from inside the new installer, with no window of its own. This hook runs during that.
  ;
  ; A MessageBox here does NOT politely disappear in that situation. NSIS's own runtime (Source/exehead/util.c:138-141)
  ; suppresses a MessageBox in silent mode only when the command carried a `/SD <button>`:
  ;
  ;     if (g_exec_flags.silent && type >> 21)
  ;       return type >> 21;
  ;     // no silent or no default, just show
  ;
  ; Ours had no /SD, so it was shown. On an upgrade the customer would see "Keep your shop data?" appear over the
  ; installer before it had done anything, and answering it decided whether their database survived -- which collided
  ; directly with the flag electron-builder had already passed: `--updated` tells the template's own app-data code to
  ; keep data regardless, and the template additionally documents `--delete-app-data` as the only way to ask for the
  ; opposite (uninstaller.nsh:216-229). Two mechanisms, both live, disagreeing about the same folder.
  ;
  ; So: in an upgrade, never prompt and never delete. Deleting on upgrade is the one outcome that cannot be undone, and
  ; it is not what the flag says. In a real uninstall the question is asked as before.
  ;
  ; ${GetParameters} and ${GetOptions} come from FileFunc.nsh, which this script already includes and already uses for
  ; the /CURRENCY= switch, so this adds no new dependency.
  ${GetParameters} $R0
  ${GetOptions} $R0 "--updated" $R9
  ${IfNot} ${Errors}
    ; An upgrade, invoked by the new installer. Leave everything alone and skip the question entirely.
    Return
  ${EndIf}

  ; The brief: "Keep my data?" defaults to yes. The database, the licence, the paired phones and the currency
  ; live in the app's data folder, which this uninstaller does not touch unless the customer says so.
  ;
  ; `/SD IDYES` is not belt-and-braces: without it, a silent run of the uninstaller by any other route -- a deployment
  ; tool, a support script, an uninstall started with /S -- would show this box and block until somebody clicked it.
  ; With it, silent means silent, and the default is the safe answer.
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1 "Keep your shop data (products, sales, users, licence and currency)?$\r$\n$\r$\nChoose Yes to keep everything and remove only the program — this is safe and is what you want if you may reinstall. Choose No to remove the program AND all shop data." /SD IDYES IDYES KeepData
    SetShellVarContext current
    RMDir /r "$APPDATA\Infoflex"
    RMDir /r "$LOCALAPPDATA\Infoflex"
    SetShellVarContext all
  KeepData:
!macroend

; electron-builder removes the files, the shortcuts and the registry entries it made. These are ours: the firewall
; rule, the autostart value, our own key, and the deliberate decision NOT to touch install-config.json.
!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Infoflex Mobile Access"'
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"
  DeleteRegKey HKLM "Software\Infoflex"

  ; install-config.json is ours, not the shop's data: the installer wrote it into ProgramData so the setup screen could
  ; arrive with the right currency preselected. It used to survive every uninstall, so a machine that had once been
  ; set up for one shop kept that shop's currency sitting in ProgramData. Nothing reads it once the program is gone,
  ; and every fresh install rewrites it (InstallApplication opens it with truncation when $WasInstalled == "0"), so
  ; deleting it unconditionally -- the "keep my data" answer does not apply to it -- is both safe and what a
  ; "removed" machine should look like.
  ReadEnvStr $0 "ProgramData"
  ${If} $0 == ""
    StrCpy $0 "C:\ProgramData"
  ${EndIf}
  Delete "$0\${INSTALLER_CONFIG_DIR}\${INSTALLER_CONFIG_FILE}"
  RMDir "$0\${INSTALLER_CONFIG_DIR}"
!macroend

Function .onInstFailed
  ; The failure path writes its own reason first, then tries to leave a log behind. If $INSTDIR is not usable the copy
  ; fails harmlessly and the message below still names the temp path, which is where the file actually is.
  !insertmacro LogLine "Result: FAILED. See the message shown to the user."
  !insertmacro FinishLog
  MessageBox MB_ICONSTOP|MB_OK "${PRODUCT_NAME} was not installed. Nothing on this computer was changed beyond what the log records.$\r$\n$\r$\nThe log is $INSTDIR\install.log." /SD IDOK
FunctionEnd
