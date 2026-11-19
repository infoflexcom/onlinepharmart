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
;
; The harness does not define INFOPLEX_OFFLINE at all, and that is deliberate. installer.nsi already defaults it to 0,
; so the online build needs nothing; and offline-include.nsh sets it to 1, which is what makes the wrapper compile here
; as its own build. Leaving the define alone means the value always comes from the file under test rather than from a
; harness that happened to agree with itself -- the distinction that hid every defect this phase found.
; PREREQUISITE_VCREDIST is deliberately NOT defined here. The harness used to define it so the offline branch's `File`
; command would resolve -- and that is precisely why nobody noticed that no real build defined it either. The offline
; installer failed to compile with `File: "${PREREQUISITE_VCREDIST}" -> no files found` while this harness built happily.
; installer.nsi now guards the command with !ifdef, so the offline branch compiles here the way it compiles for real:
; without the file, and without a define this harness invented.

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
; electron-builder's shared header includes this before the templates compile, so the real build has
; ${StdUtils.ExecShellAsUser}. The harness has to provide the same names or it tests a script that cannot exist:
; the finish page's "Launch now" uses it deliberately, because a plain Exec would start the app elevated.
!include "StdUtils.nsh"

; APP_GUID and UNINSTALL_APP_KEY are passed by electron-builder on the makensis command line
; (NsisTarget.js:265, :267), so they belong with the other -D values above. Everything DERIVED from them --
; INSTALL_REGISTRY_KEY, UNINSTALL_REGISTRY_KEY -- comes from multiUser.nsh:8-9, which electron-builder's own template
; includes (templates/nsis/installer.nsi:10). The harness includes it too rather than restating the two defines: a copy
; of a formula drifts from the formula, and the "the harness invents no values" test below cannot tell a faithful copy
; from an invention.
!define APP_GUID "00000000-0000-0000-0000-000000000000"
!define UNINSTALL_APP_KEY "infoflex-harness-uninstall-key"
!define SHORTCUT_NAME "${PRODUCT_NAME}"
!include "multiUser.nsh"

Var /GLOBAL customInstallDir
Var /GLOBAL appExe
Var /GLOBAL launchLink
; The link variables electron-builder's setLinkVars computes (common.nsh:85-110) and its install section then uses.
; The rollback path deletes them, so the harness must declare them or it reports "unknown variable" warnings that -WX
; turns into a failed build -- a failure about the harness, presented as a failure about the script.
Var /GLOBAL newStartMenuLink
Var /GLOBAL newDesktopLink
Var /GLOBAL oldStartMenuLink
Var /GLOBAL oldDesktopLink

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
; Which file to compile. Normally installer.nsi. The shipping offline build does not include that file directly: it
; includes offline-include.nsh, a one-line wrapper that sets INFOPLEX_OFFLINE and includes installer.nsi. Nothing
; compiled that wrapper, so a typo in it would have been found only by a real `npm run build` on Windows -- the same
; shape as every defect this harness has found. The driver compiles it as a third build by passing this define.
!ifndef HARNESS_ENTRY
  !define HARNESS_ENTRY "installer.nsi"
!endif
!include "${HARNESS_ENTRY}"

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

