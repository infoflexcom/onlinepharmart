import { useEffect, useRef } from 'react'
import type { PendingMobileApproval } from '@shared/mobile/types'

interface Props {
  requests: PendingMobileApproval[]
  busy: boolean
  onApprove(request: PendingMobileApproval): void
  onReject(request: PendingMobileApproval): void
  onDismiss(request: PendingMobileApproval): void
}

/**
 * The pop-up the Admin sees when a phone scans the pairing code. It states the phone's own name, the phone
 * type and the four-digit code the phone is displaying, so the Admin can confirm the request in front of them
 * is the one being approved — not one an attacker triggered from another device on the network.
 */
export function PairingApprovalDialog({ requests, busy, onApprove, onReject, onDismiss }: Props) {
  const dialog = useRef<HTMLDivElement>(null)
  const first = requests[0]

  useEffect(() => {
    // Focus the approve button so an Admin at the keyboard can act without hunting with the mouse.
    dialog.current?.querySelector<HTMLButtonElement>('[data-approve]')?.focus()
  }, [first?.requestId])

  if (!first) return null

  return (
    <div className="pairing-dialog__scrim" role="presentation">
      <div
        ref={dialog}
        className="pairing-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="pairing-dialog-title"
        aria-describedby="pairing-dialog-body"
      >
        <span className="mobile-access__eyebrow">PHONE ASKING TO CONNECT</span>
        <h3 id="pairing-dialog-title">Approve “{first.deviceName}”?</h3>
        <p id="pairing-dialog-body">
          A phone on this network entered your pairing code and is waiting for you. Approve it only if the phone
          shows the same code below.
        </p>
        <div className="pairing-dialog__facts">
          <div><span>Phone</span><strong>{first.deviceName}</strong></div>
          <div><span>Type</span><strong>{first.platform}</strong></div>
          <div><span>Code on the phone</span><strong className="pairing-dialog__code">{first.code || '—'}</strong></div>
          {first.ipAddress && <div><span>Network address</span><strong>{first.ipAddress}</strong></div>}
        </div>
        {requests.length > 1 && <p className="mobile-access__hint">{requests.length - 1} more phone{requests.length - 1 === 1 ? '' : 's'} waiting after this one.</p>}
        <div className="pairing-dialog__actions">
          <button type="button" className="mobile-access__button is-primary" data-approve disabled={busy} onClick={() => onApprove(first)}>Approve this phone</button>
          <button type="button" className="mobile-access__button is-danger" disabled={busy} onClick={() => onReject(first)}>Do not approve</button>
          <button type="button" className="mobile-access__text-button" disabled={busy} onClick={() => onDismiss(first)}>Decide later</button>
        </div>
        <p className="mobile-access__hint">
          Approving does not sign the phone in: the Admin must still enter the Admin username, password{''}
          and — over the Internet — an authenticator code.
        </p>
      </div>
    </div>
  )
}
