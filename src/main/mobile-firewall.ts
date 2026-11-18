import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { MobileFirewallProbe } from '../services/mobile-access-service'

const run = promisify(execFile)
const RULE_NAME = 'Infoflex Mobile Access'

export interface FirewallProbeOptions {
  /** Injected in tests; production uses PowerShell through execFile so no shell parsing is involved. */
  execute?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
  platform?: NodeJS.Platform
}

/**
 * Checks and repairs the Windows Firewall inbound rule for the mobile host port.
 *
 * This is the only place Infoflex touches the firewall, and it is deliberately narrow: one rule, one port,
 * Private profile only, and only when the Admin presses "Repair firewall rule". Nothing is changed silently.
 */
export function createWindowsFirewallProbe(options: FirewallProbeOptions = {}): MobileFirewallProbe {
  const platform = options.platform ?? process.platform
  const execute = options.execute ?? ((file, args) => run(file, args, { windowsHide: true, timeout: 15_000 }))

  const inspectScript = (): string => `
$ErrorActionPreference = 'SilentlyContinue'
$rule = Get-NetFirewallRule -DisplayName '${RULE_NAME}' | Select-Object -First 1
if (-not $rule) { Write-Output 'MISSING'; exit 0 }
if ($rule.Enabled -ne 'True' -or $rule.Action -ne 'Allow' -or $rule.Direction -ne 'Inbound') { Write-Output 'WRONG'; exit 0 }
$profiles = @($rule | Get-NetFirewallProfile | Select-Object -ExpandProperty Name)
$portFilter = $rule | Get-NetFirewallPortFilter
Write-Output ("OK|{0}|{1}|{2}" -f ($profiles -join ','), $portFilter.LocalPort, $rule.Profile)
`.trim()

  const repairScript = (port: number): string => `
$ErrorActionPreference = 'Stop'
Get-NetFirewallRule -DisplayName '${RULE_NAME}' | Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName '${RULE_NAME}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Profile Private -Description 'Allows the shop Admin phone to reach Infoflex on this private network only.' | Out-Null
Write-Output 'REPAIRED'
`.trim()

  const interpret = (port: number, stdout: string): { blocked: boolean; message: string | null } => {
    const text = stdout.trim()
    if (text.startsWith('OK|')) {
      const [, profiles = '', localPort = ''] = text.split('|')
      const onPrivate = profiles.split(',').some((name) => name.trim().toLowerCase() === 'private' || name.trim() === 'Any')
      if (onPrivate && (localPort === String(port) || localPort === 'Any')) return { blocked: false, message: null }
      return { blocked: true, message: firewallMessage(port) }
    }
    return { blocked: true, message: firewallMessage(port) }
  }

  return {
    async inspect(port) {
      if (platform !== 'win32') return { blocked: false, message: null }
      try {
        const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', inspectScript()])
        return interpret(port, stdout)
      } catch {
        // A failed query must not claim the port is blocked; the Admin can still use "Test connection".
        return { blocked: false, message: null }
      }
    },
    async repair(port) {
      if (platform !== 'win32') {
        return { blocked: true, message: 'Firewall repair is only available on Windows.' }
      }
      try {
        await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', repairScript(port)])
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Windows did not allow the firewall change.'
        throw new Error(`The firewall rule could not be repaired. Windows said: ${detail.slice(0, 200)}. If Windows asks for permission, choose Yes, then press Repair again.`)
      }
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', inspectScript()])
      if (!stdout.trim().startsWith('OK|')) {
        return { blocked: true, message: 'Windows still reports the rule as blocked. Approve the Infoflex request when Windows asks, then press Repair again.' }
      }
      return interpret(port, stdout)
    },
  }
}

/** Plain words, no jargon, and an actionable next step — this is read by a non-technical shop owner. */
export function firewallMessage(port: number): string {
  return `Windows Firewall is blocking this computer's mobile port (${port}). Windows has not allowed the Admin's phone to reach Infoflex on this private network. Press "Repair firewall rule" to let it through, then try the phone again.`
}
