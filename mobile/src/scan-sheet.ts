import type { ScannerHandle } from './barcode-scanner'

/**
 * The scan sheet: a full-screen camera with a torch toggle and a manual-entry fallback.
 *
 * It resolves once with the scanned (or typed) barcode, or null when the Admin closes it. A phone without a
 * camera, a refused permission, or a barcode the camera cannot read all end on the manual entry field, so no
 * screen is ever blocked by the camera.
 */
/**
 * Camera support is a cheap capability check, so it stays in the shell. The ZXing decoder itself is a
 * ~380 kB chunk; it is imported only when the Admin opens the scanner, which keeps the first paint on a
 * weak phone connection fast. Scanning is an online action anyway — the camera opens on a page that is
 * already loaded from the host.
 */
export function cameraSupported(): boolean {
  if (typeof navigator === 'undefined') return false
  return Boolean(navigator.mediaDevices?.getUserMedia)
}

export interface ScanSheetOptions {
  title: string
  hint?: string
  manualLabel?: string
}

export function openBarcodeScanner(options: ScanSheetOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement as HTMLElement | null
    let handle: ScannerHandle | null = null
    let settled = false

    const scrim = el('div', 'sheet-scrim')
    const sheet = el('section', 'sheet sheet--camera')
    sheet.setAttribute('role', 'dialog')
    sheet.setAttribute('aria-modal', 'true')
    sheet.setAttribute('aria-label', options.title)

    const closeButton = el('button', 'sheet__close', '✕')
    closeButton.type = 'button'
    closeButton.setAttribute('aria-label', 'Close the scanner')

    const heading = el('h2', 'sheet__title', options.title)
    const hint = el('p', 'sheet__hint', options.hint ?? 'Point the camera at the barcode on the item.')

    const video = document.createElement('video')
    video.className = 'scanner__video'
    video.setAttribute('playsinline', 'true')
    video.setAttribute('muted', 'true')
    video.muted = true

    const status = el('p', 'scanner__status', 'Starting the camera…')
    status.setAttribute('role', 'status')

    const torch = el('button', 'button button--quiet scanner__torch', 'Torch')
    torch.type = 'button'
    torch.disabled = true

    const manual = el('form', 'scanner__manual')
    const manualLabel = el('label', 'field__label', options.manualLabel ?? 'Or type the barcode')
    const manualInput = document.createElement('input')
    manualInput.className = 'field__input'
    manualInput.type = 'text'
    manualInput.inputMode = 'numeric'
    manualInput.autocomplete = 'off'
    manualInput.setAttribute('autocapitalize', 'off')
    manualInput.setAttribute('spellcheck', 'false')
    manualInput.placeholder = 'Enter the barcode'
    const manualSubmit = el('button', 'button button--primary', 'Use this barcode')
    manualSubmit.type = 'submit'
    manualLabel.htmlFor = 'scan-manual-input'
    manualInput.id = 'scan-manual-input'
    manual.append(manualLabel, manualInput, manualSubmit)

    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      handle?.stop()
      document.removeEventListener('keydown', onKeyDown)
      scrim.remove()
      previousFocus?.focus?.()
      resolve(value)
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') finish(null)
    }

    closeButton.addEventListener('click', () => finish(null))
    scrim.addEventListener('click', (event) => {
      if (event.target === scrim) finish(null)
    })
    manual.addEventListener('submit', (event) => {
      event.preventDefault()
      const value = manualInput.value.trim()
      if (!value) {
        manualInput.focus()
        return
      }
      finish(value)
    })
    torch.addEventListener('click', () => {
      if (!handle) return
      void handle.setTorch(torch.getAttribute('aria-pressed') !== 'true').then((applied) => {
        if (!applied) {
          status.textContent = 'This phone does not offer a torch to the browser. Use the room light instead.'
          return
        }
        const next = torch.getAttribute('aria-pressed') !== 'true'
        torch.setAttribute('aria-pressed', next ? 'true' : 'false')
      })
    })

    sheet.append(closeButton, heading, hint, video, status, torch, manual)
    scrim.append(sheet)
    document.body.append(scrim)
    document.addEventListener('keydown', onKeyDown)
    manualInput.focus()

    if (!cameraSupported()) {
      video.remove()
      torch.remove()
      status.textContent = 'This browser cannot open the camera. Type the barcode below.'
      return
    }

    void loadScanner().then(async (module) => module.startScanning({
      video,
      onReady: () => {
        status.textContent = 'Camera ready. Hold the barcode steady inside the frame.'
        torch.disabled = false
      },
      onResult: (result) => {
        // A short vibration confirms a scan without needing to look at the screen.
        try { navigator.vibrate?.(40) } catch { /* not supported on iPhone */ }
        finish(result.text)
      },
      onError: (message) => {
        video.classList.add('is-hidden')
        torch.remove()
        status.textContent = message
      },
    })).then((started) => {
      handle = started
      torch.disabled = !started.hasTorch()
      if (!started.hasTorch()) torch.setAttribute('aria-disabled', 'true')
    }).catch((error: unknown) => {
      status.textContent = error instanceof Error && error.message.includes('camera')
        ? error.message
        : 'The scanner could not load. Type the barcode below instead.'
    })
  })
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

async function loadScanner() {
  // A single dynamic import, cached by the browser after the first scan.
  return await import('./barcode-scanner')
}
