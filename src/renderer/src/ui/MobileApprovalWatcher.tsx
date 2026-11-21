import { useCallback, useEffect, useState } from 'react'
import type { InfoflexBridge } from '@shared/bridge'
import type { PendingMobileApproval } from '@shared/mobile/types'
import { PairingApprovalDialog } from './PairingApprovalDialog'
import './mobile-access.css'

interface Props {
  bridge: InfoflexBridge
  /** A non-Admin never sees this dialog; the host would refuse the request anyway. */
  enabled: boolean
}

const POLL_MS = 5_000

/**
 * Watches for phones waiting for approval no matter which screen the Admin is on, so pairing does not depend
 * on the Admin happening to have Mobile Access open. It is deliberately silent on failure: a background poll
 * must never interrupt work with an error dialog.
 */
export function MobileApprovalWatcher({ bridge, enabled }: Props) {
  const [pending, setPending] = useState<PendingMobileApproval[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const poll = useCallback(async () => {
    if (!enabled) return
    try {
      setPending(await bridge.listPendingMobileApprovals())
    } catch {
      // Not signed in yet, mobile access switched off, or no licence: nothing to show.
    }
  }, [bridge, enabled])

  useEffect(() => {
    if (!enabled) return
    void poll()
    const timer = window.setInterval(() => { void poll() }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [enabled, poll])

  async function decide(request: PendingMobileApproval, approve: boolean): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const next = approve
        ? await bridge.approveMobileDevice(request.requestId)
        : await bridge.rejectMobileDevice(request.requestId)
      setPending(next)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'That pairing request could not be completed.')
    } finally {
      setBusy(false)
    }
  }

  if (pending.length === 0 && !error) return null

  return (
    <>
      {error && <div className="pairing-dialog__scrim" role="presentation">
        <div className="pairing-dialog" role="alertdialog" aria-modal="true" aria-labelledby="pairing-error-title">
          <h3 id="pairing-error-title">That pairing request could not be completed</h3>
          <p>{error}</p>
          <div className="pairing-dialog__actions">
            <button type="button" className="mobile-access__button" onClick={() => setError('')}>Close</button>
          </div>
        </div>
      </div>}
      {pending.length > 0 && <PairingApprovalDialog
        requests={pending}
        busy={busy}
        onApprove={(request) => void decide(request, true)}
        onReject={(request) => void decide(request, false)}
        onDismiss={(request) => setPending((current) => current.filter((item) => item.requestId !== request.requestId))}
      />}
    </>
  )
}
