; ============================================================================================== JSON escaping
;
; JSON string escaping for the values the installer writes into install-config.json, by hand because NSIS has no
; JSON writer and shelling out to a helper would mean the currency could not be recorded if that helper failed.
;
; Why it matters: a custom currency is typed by a person. A value containing a quote, a backslash or a tab makes
; the file invalid JSON, and the app treats invalid JSON as "the installer said nothing" — so the shop's choice is
; lost silently and it opens on the default currency. These escapes are the fix for that.
;
; What is NOT handled here, and is refused instead: a letter outside ASCII inside a custom currency. Emitting
; \uXXXX needs the code point of a character, NSIS gives no way to get one short of a plugin, and guessing at a
; multi-byte encoding in a script that cannot be compiled in this project is how a silent corruption gets shipped.
; `validateCustomCurrencyForInstaller` in installer-policy.ts refuses such a value with a plain-words message, so
; the installer never reaches this function with one. Built-in currencies are pure ASCII by construction — the
; generator enforces that where the table is built, not here.

!ifndef INFOPLEX_JSON_ESCAPING_INCLUDED
!define INFOPLEX_JSON_ESCAPING_INCLUDED

; Escapes the text in $3, leaving the result in $3. Clobbers $0 and $1.
;
; NSIS string syntax, which is where this is easy to get wrong: inside a quoted string, $\" is a double quote and
; a lone backslash is a backslash. So a JSON backslash is written as two characters and a JSON quote as
; backslash-then-quote.
Function EscapeJson
  Push $0
  Push $1

  StrCpy $0 $3
  StrCpy $3 ""

  escape_loop:
    StrCpy $1 $0 1
    StrCmp $1 "" escape_done
    StrCpy $0 $0 "" 1

    ; " becomes \"
    StrCmp $1 '$\"' 0 +3
      StrCpy $3 '$3$\"$\"'
      Goto escape_loop

    ; A backslash doubles
    StrCmp $1 '\' 0 +3
      StrCpy $3 '$3\\'
      Goto escape_loop

    ; A carriage return inside a value has no place in a line-ending-terminated file; drop it.
    StrCmp $1 '$\r' 0 +2
      Goto escape_loop

    ; Newline and tab have no bare form in JSON.
    StrCmp $1 '$\n' 0 +3
      StrCpy $3 '$3\n'
      Goto escape_loop
    StrCmp $1 '$\t' 0 +3
      StrCpy $3 '$3\t'
      Goto escape_loop

    StrCpy $3 "$3$1"
    Goto escape_loop

  escape_done:
  Pop $1
  Pop $0
FunctionEnd

!endif
