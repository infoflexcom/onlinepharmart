; ==========================================================================================
; Compile harness for installer.nsi
;
; SCOPE, STATED PLAINLY: this does NOT produce an installer, and a failure here is not proof that the real build
; fails. It compiles the real installer/nsis/installer.nsi against the real NSIS headers, with the handful of macros
; and defines that electron-builder's template would normally supply replaced by minimal stand-ins. What it proves is
; that the script parses, that every macro invocation resolves, that every String instruction and Var is legal, that
; the ${If}/${EndIf} nesting balances across the whole file, and that nsDialogs/MUI2/FileFunc are used correctly. What
; it cannot prove is that electron-builder's own template agrees with us -- page ordering, whether customInstall runs
; at the right point, or whether the payload is in the right directory.
;
; That boundary is worth having. Every defect this harness was written to catch -- an unbalanced ${If}, a mistyped
; macro, a Var declared twice, a Function referenced by a Page command but never defined -- is a defect the static
; checker in installer/src/check-nsis-script.ts cannot see, because those are consequences of NSIS's own grammar.
;
; Driven by scripts/compile-check-installer.ts.
; ==========================================================================================

!define PRODUCT_NAME "Infoflex"
!define PRODUCT_VERSION "0.0.0-harness"
; electron-builder's template defines APP_VERSION; the script writes it into install-config.json, and without it NSIS
; emits "unknown variable/constant {APP_VERSION} detected, ignoring" and writes a literal "${APP_VERSION}" to the file.
!define APP_VERSION "0.0.0-harness"
!define APP_PACKAGE_NAME "infoflex"
; Set INFOPLEX_OFFLINE=1 on the command line (-DINFOPLEX_OFFLINE=1) to compile the offline build's branch, which
; bundles the Visual C++ runtime instead of downloading it. Both branches are worth compiling: they differ, and only
; one of them runs in any given installer.
!ifndef INFOPLEX_OFFLINE
  !define INFOPLEX_OFFLINE 0
!endif
!ifndef PREREQUISITE_VCREDIST
  !define PREREQUISITE_VCREDIST "/tmp/infoflex-harness-resources/password-check.exe"
!endif

; electron-builder sets these. The harness points BUILD_RESOURCES_DIR at a folder holding placeholders for the two files
; our script references, because NSIS checks that a `File` source exists at compile time -- a check worth keeping, since
; a missing password-checker helper must never reach a customer.
!ifndef BUILD_RESOURCES_DIR
  !define BUILD_RESOURCES_DIR "/tmp/infoflex-harness-resources"
!endif

; electron-builder sets this from `perMachine: true`; the real template emits RequestExecutionLevel from it. Set by
; the harness so the same #ifdef branches are taken as in a real build.
!define INSTALL_MODE_PER_ALL_USERS

Name "${PRODUCT_NAME}"

; Where the compiled installer is written. The driver passes an absolute path per build (online, offline) so the two
; cannot overwrite each other -- a shared name would let one build's output satisfy the other build's check, which is
; exactly the kind of false pass this harness exists to avoid. NSIS resolves a relative OutFile against the script's own
; directory, not the working directory, so passing a relative path from a driver would not have been enough.
!ifndef HARNESS_OUTFILE
  !define HARNESS_OUTFILE "harness-output.exe"
!endif
OutFile "${HARNESS_OUTFILE}"
InstallDir "$PROGRAMFILES\${PRODUCT_NAME}"
RequestExecutionLevel admin

; MUI2 reads its dialog resources with ChangeUI, which expects a Windows PE. Building those needs a Windows resource
; compiler, which this harness does not have and does not need: ChangeUI only reads the file at link time, and NSIS
; reports a missing file before it gets that far. Pointing it at a file that exists lets every declaration and page
; macro be checked, which is the whole purpose here.
; Overridable with -D so the driver can pass the path it built the placeholder PE at.
!ifndef MUI_UI
  !define MUI_UI "/tmp/modern.exe"
  !define MUI_UI_HEADERIMAGE "${MUI_UI}"
  !define MUI_UI_COMPONENTSPAGE_SMALLDESC "${MUI_UI}"
  !define MUI_UI_COMPONENTSPAGE_NODESC "${MUI_UI}"
!endif

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "WinVer.nsh"
!include "FileFunc.nsh"
!include "Sections.nsh"

Var /GLOBAL customInstallDir
Var /GLOBAL appExe
Var /GLOBAL launchLink

; ---- the electron-builder-provided macros our script expects in scope when its hooks are inserted ----------------
; In a real build these come from the template. The harness gives them a body that compiles, so a syntax error in the
; surrounding code is still reported, without pretending to be the real thing.
!macro installApplicationFiles
!macroend

; electron-builder's installSection.nsh inserts customInstall at the point where the payload has been copied. The
; harness inserts it in its own Install section far below, for the same reason.

; ==========================================================================================
; The file under test. It must be included before anything inserts its macros -- NSIS resolves a macro only after the
; !macro line has been read. electron-builder's template does the same, for the same reason.
; ==========================================================================================
!include "installer.nsi"

; installer.nsi disables three warnings by number, because electron-builder builds with -WX and any warning is fatal
; there. That is right for the real build and blind for this harness: warning 6010 is the only signal NSIS gives that it
; threw a function body away, and silence on a page function is exactly how four custom pages went missing unnoticed.
;
; So the harness turns 6010 back on. The compile driver passes -WX, which makes any OTHER warning fatal, and re-enables
; nothing else. 6020 (no WriteUninstaller in this harness) and 6001 (template-owned variables) stay suppressed: they
; are artefacts of compiling a fragment rather than the whole installer, and neither can hide a missing page.
!pragma warning enable 6010

; ---- pages -----------------------------------------------------------------------------------------------
;
; These mirror electron-builder's insertion points exactly (assistedInstaller.nsh lines 9, 43 and 48), and the hooks
; matter more than they look. `customPageAfterChangeDir` is where our four custom Page commands live, so WITHOUT this
; insertion the four page functions are never referenced, NSIS emits "warning 6010 ... not referenced - zeroing code",
; and their bodies -- including the currency page's entire read-back logic -- are discarded unexamined. That is how a
; planted `${NSD_LB_BogusMacro}` on the currency page went undetected on the first run of this harness.
!insertmacro customWelcomePage
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro customFinishPage

!insertmacro MUI_LANGUAGE "English"

; ---- page helper functions the template would provide ------------------------------------------------------
Section "Install" SecInstall
  ; The real electron-builder template does the payload copy and the registry writes here. The harness does neither,
  ; so nothing outside the script's own hooks is being exercised.
  !insertmacro customInstall
SectionEnd

Section "Uninstall"
  !insertmacro customUnInstall
SectionEnd

