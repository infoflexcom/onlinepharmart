; ==========================================================================================
; The uninstaller pass.
;
; electron-builder compiles the installer **twice**. The second pass defines BUILD_UNINSTALLER, and only then does its
; template include `uninstaller.nsh` — which is the only thing that ever inserts our `customUnInstall` macro. That macro
; deletes the firewall rule, the autostart entry and the HKLM software key; if it did not compile, the uninstaller
; would not build at all, and if it were inserted in the wrong place it would run after the files were gone.
;
; The main harness cannot cover this. It compiles one script in one pass with the installer's environment, and it inserts
; the page hooks itself; there is no BUILD_UNINSTALLER path through it. So this file exists to be the second pass, and
; `npm run installer:compile` runs it as a fourth build.
;
; It is deliberately NOT an electron-builder replica. electron-builder's own `uninstaller.nsh` wraps the macro in a
; Section and calls it in place; reproducing that here would mean reproducing a template that changes between versions.
; What is checked is the thing that belongs to this repository: the macro itself, and the uninstaller-only functions our
; script defines, compile under the same `-WX` the real build uses.
; ==========================================================================================

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "WinVer.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
!include "Sections.nsh"

Name "${PRODUCT_NAME}"
OutFile "${HARNESS_OUTFILE}"
InstallDir "$PROGRAMFILES\${PRODUCT_NAME}"

; What electron-builder supplies on its command line. Kept minimal on purpose: only the values installer.nsi reads.
!define PRODUCT_VERSION "0.0.0-uninstaller"
!ifndef APP_VERSION
  !define APP_VERSION "0.0.0-uninstaller"
!endif
!ifndef PRODUCT_FILENAME
  !define PRODUCT_FILENAME "${PRODUCT_NAME}"
!endif
!ifndef APP_PACKAGE_NAME
  !define APP_PACKAGE_NAME "infoflex"
!endif
!ifndef APP_FILENAME
  !define APP_FILENAME "${PRODUCT_NAME}"
!endif
!ifndef APP_GUID
  !define APP_GUID "00000000-0000-0000-0000-000000000000"
!endif
!ifndef UNINSTALL_APP_KEY
  !define UNINSTALL_APP_KEY "uninstall-key"
!endif
!ifndef APP_ID
  !define APP_ID "com.infoflex.pharmart"
!endif
!ifndef BUILD_RESOURCES_DIR
  !define BUILD_RESOURCES_DIR "/tmp/infoflex-harness-resources"
!endif
!define INSTALL_MODE_PER_ALL_USERS

; The electron-builder-provided macro our script expects in scope.
!macro installApplicationFiles
!macroend

; The condition that makes this the uninstaller pass, and the output path electron-builder passes so its own template
; can find the binary. Both are set after the defines above so they cannot be overridden by them.
!define BUILD_UNINSTALLER
!ifndef UNINSTALLER_OUT_FILE
  !define UNINSTALLER_OUT_FILE "Z:\infoflex-harness-uninstaller.exe"
!endif

; The file under test.
!include "installer.nsi"

; The uninstall section, inserted the way electron-builder's uninstaller.nsh does it: inside a Section, after the link
; variables are computed. That is what proves customUnInstall's body is valid where it actually runs.
;
; Two things about this Section are worth knowing, because both produce the same unhelpful error -- `no sections
; specified` -- and neither points at the cause:
;
;  1. It must be defined BEFORE the page macros. With the pages first, NSIS says `warning 8000: Page instfiles not used,
;     no sections will be executed`, which under -WX is fatal.
;  2. It must NOT be named "Uninstall" or begin with "un.". NSIS's add_section switches to uninstaller mode on those
;     names, which puts the section in a different list entirely, so the installer pass then reports that it has no
;     sections at all. electron-builder's own uninstaller.nsh deliberately uses the "un." prefix because it IS building
;     an uninstaller; this file is only proving that customUnInstall's body compiles, so it avoids the reserved name
;     and the uninstaller machinery that comes with it.
; electron-builder's uninstaller.nsh defines `Function un.onInit` itself, and this script is layered into that same
; compile. Reproducing that function here is what makes the check able to see a second `un.onInit` in our script -- the
; exact defect that made the real uninstaller pass fail with `Function named "un.onInit" already exists`. Without it
; this build compiles cleanly while the shipping build does not, which is the whole failure mode it exists to prevent.
Function un.onInit
  ; The template's body is not reproduced; only its existence and its two hooks are, because a name collision is what
  ; is being tested, not the template's behaviour.
  !ifmacrodef customUnInit
    !insertmacro customUnInit
  !endif
FunctionEnd

Section "Remove everything Infoflex added"
  SectionIn RO
  !insertmacro customUnInstall
SectionEnd

!insertmacro customWelcomePage
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro customFinishPage

!insertmacro MUI_LANGUAGE "English"
