/**
 * Reading the Authenticode signature of a downloaded installer.
 *
 * This is the check that stands between a compromised download and the customer's machine, so it is worth separating
 * from the process plumbing and testing on its own. What is tested here is the part that can be wrong in a way nobody
 * notices: the PowerShell quoting and the interpretation of the result.
 *
 * **The quoting matters.** The path is pasted into a PowerShell command, so a path containing a quote must not be able
 * to end the string literal and append a command of its own. PowerShell escapes a single quote inside a single-quoted
 * string by doubling it — `''` — which is what this does. Backtick and `$` are literal inside single quotes, so they
 * need no handling, and that is exactly why single quotes are used rather than double.
 */

/** The PowerShell that prints the publisher's subject name, or nothing when the file is unsigned. */
export function authenticodeScript(path: string): string {
  return `(Get-AuthenticodeSignature -LiteralPath '${path.replace(/'/gu, "''")}').SignerCertificate.Subject`
}

/**
 * What the check concluded from PowerShell's output.
 *
 * Fails closed in every uncertain case. A timeout, a missing PowerShell, a non-zero exit, an empty answer and an
 * answer that is obviously not a publisher name all resolve to `null`, which the caller treats as "do not run this".
 */
export function interpretAuthenticode(input: {
  exitCode: number | null
  stdout: string
}): string | null {
  if (input.exitCode !== 0) return null
  const subject = input.stdout.trim()
  if (!subject) return null
  // An unsigned file prints an empty string; a file that could not be read prints nothing too. Anything that is not
  // a plain single-line value is not a publisher name, and guessing would defeat the check.
  if (subject.includes('\n')) return null
  return subject
}

/** Whether a signature check is meaningful on this platform. Off Windows there is no Authenticode at all. */
export function canCheckAuthenticode(platform: NodeJS.Platform): boolean {
  return platform === 'win32'
}
