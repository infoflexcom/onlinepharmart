import { describe, expect, it } from 'vitest'
import { authenticodeScript, canCheckAuthenticode, interpretAuthenticode } from './authenticode'

/**
 * The signature check on a downloaded installer.
 *
 * Two things are being defended here. The first is the customer's machine: a file whose publisher cannot be read must
 * not be run, so every uncertain answer has to come back as `null`. The second is the quoting — the downloaded file's
 * path is pasted into a PowerShell command, and a vendor whose name contains an apostrophe (or a file saved under a
 * folder that does) must not be able to break the command, let alone append one.
 */

describe('the PowerShell that reads a signature', () => {
  it('quotes an ordinary path plainly', () => {
    expect(authenticodeScript('C:\\Temp\\vc_redist.x64.exe'))
      .toBe("(Get-AuthenticodeSignature -LiteralPath 'C:\\Temp\\vc_redist.x64.exe').SignerCertificate.Subject")
  })

  it('doubles a quote inside the path so it cannot end the string', () => {
    // The classic injection attempt. Inside a single-quoted PowerShell string `''` is a literal quote, so the whole
    // thing stays one argument.
    const script = authenticodeScript("C:\\Temp\\it's-here.exe")
    expect(script).toContain("'C:\\Temp\\it''s-here.exe'")
    // One opening and one closing quote around the path: the doubled pair is inside it.
    const literal = /-LiteralPath '(.*)'\)\.SignerCertificate/u.exec(script)?.[1]
    expect(literal).toBe("C:\\Temp\\it''s-here.exe")
  })

  it('cannot be made to run a second command', () => {
    // A path crafted to close the quote and add a command. After doubling, the payload is inert text.
    const evil = "C:\\a.exe'; Remove-Item -Recurse C:\\Users; '"
    const script = authenticodeScript(evil)
    const literal = /-LiteralPath '(.*)'\)\.SignerCertificate/u.exec(script)?.[1]!
    // Every quote inside the literal is doubled, so there is no unescaped `'` to close it.
    expect(literal.replace(/''/gu, '')).not.toContain("'")
    expect(script.endsWith("').SignerCertificate.Subject")).toBe(true)
  })

  it('keeps a dollar or backtick literal, because single quotes do that', () => {
    // `$(...)` and backticks are interpolation in PowerShell only inside double quotes; this is why single quotes are
    // used. A vendor downloading into a folder named with a `$` must still work.
    const script = authenticodeScript('C:\\$Recycle.Bin`n\\x.exe')
    expect(script).toContain('$Recycle.Bin`n')
  })
})

describe('reading the answer', () => {
  it('accepts a publisher name from a clean run', () => {
    expect(interpretAuthenticode({ exitCode: 0, stdout: 'CN=Microsoft Corporation, O=Microsoft Corporation\r\n' }))
      .toBe('CN=Microsoft Corporation, O=Microsoft Corporation')
  })

  it('treats an unsigned file as unverifiable rather than fine', () => {
    // Get-AuthenticodeSignature prints nothing for an unsigned file.
    expect(interpretAuthenticode({ exitCode: 0, stdout: '' })).toBeNull()
    expect(interpretAuthenticode({ exitCode: 0, stdout: '   \r\n ' })).toBeNull()
  })

  it('fails closed on a non-zero exit or no exit at all', () => {
    // A kill on timeout, a PowerShell that refused to run, a crash: none of these is a signature.
    expect(interpretAuthenticode({ exitCode: 1, stdout: 'CN=Someone' })).toBeNull()
    expect(interpretAuthenticode({ exitCode: null, stdout: 'CN=Someone' })).toBeNull()
  })

  it('refuses an answer that is not a single value', () => {
    // An error message echoed across lines is not a publisher. Guessing here would defeat the check.
    expect(interpretAuthenticode({ exitCode: 0, stdout: 'CN=A\nCN=B' })).toBeNull()
  })
})

describe('where the check applies', () => {
  it('only claims to verify on Windows', () => {
    expect(canCheckAuthenticode('win32')).toBe(true)
    expect(canCheckAuthenticode('linux')).toBe(false)
    expect(canCheckAuthenticode('darwin')).toBe(false)
  })
})
