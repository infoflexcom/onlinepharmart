; The offline installer's entry point into our pages.
;
; electron-builder's `include` option takes ONE file, and the offline build differs from the online build by a single
; compile-time define. So this wrapper sets the define and then pulls in the pages themselves — the same file the
; online build includes, unchanged. The two installers therefore cannot drift: there is one set of pages, one password
; gate, one currency page, and only the download behaviour differs.
;
; Guarded rather than a bare `!define`: NSIS treats redefining a define as a hard error, and this file is compiled by
; the check as well as by electron-builder. A caller that has already chosen a value keeps it.
!ifndef INFOPLEX_OFFLINE
  !define INFOPLEX_OFFLINE 1
!endif
!include "installer.nsi"
