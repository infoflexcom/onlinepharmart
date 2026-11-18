import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser'
import { DecodeHintType, BarcodeFormat } from '@zxing/library'

/**
 * Camera barcode scanning for both Android Chrome and iPhone Safari.
 *
 * `BarcodeDetector` is not available on Safari and only sometimes on Android, so scanning is done with ZXing
 * (`@zxing/browser`), which decodes frames in JavaScript from a `<video>` element. That is the only approach
 * that works on both platforms the brief names. Formats are limited to the ones a pharmacy or supermarket
 * actually prints — EAN-13/EAN-8, UPC-A/UPC-E, Code-128, Code-39, ITF and QR — because widening the search
 * slows decoding on a mid-range phone.
 */

export interface ScanResult {
  text: string
  format: string
}

export interface ScannerHandle {
  stop(): void
  setTorch(on: boolean): Promise<boolean>
  hasTorch(): boolean
}

export interface StartScanningOptions {
  video: HTMLVideoElement
  onResult: (result: ScanResult) => void
  onError: (message: string) => void
  /** Called once when the camera is live, so the screen can hide its "starting camera" note. */
  onReady?: () => void
}

export function cameraErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'The camera is blocked. Allow camera access for this page in the browser settings, then try again. You can also type the barcode below.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No camera was found on this phone. Type the barcode below instead.'
  }
  if (name === 'NotReadableError') {
    return 'The camera is being used by another app. Close that app, then try again — or type the barcode below.'
  }
  return 'The camera could not start. Type the barcode below instead.'
}

/** True when this browser can be expected to open a camera at all. */
export function cameraSupported(): boolean {
  if (typeof navigator === 'undefined') return false
  return Boolean(navigator.mediaDevices?.getUserMedia)
}

export async function startScanning(options: StartScanningOptions): Promise<ScannerHandle> {
  const hints = new Map()
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
    BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF, BarcodeFormat.QR_CODE,
  ])
  hints.set(DecodeHintType.TRY_HARDER, true)
  const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 120 })

  let stopped = false
  let controls: IScannerControls | null = null
  let torchOn = false

  const handle: ScannerHandle = {
    stop() {
      if (stopped) return
      stopped = true
      try { controls?.stop() } catch { /* the element may already be detached */ }
      controls = null
    },
    hasTorch() {
      return typeof controls?.switchTorch === 'function'
    },
    async setTorch(on: boolean) {
      if (typeof controls?.switchTorch !== 'function') return false
      try {
        await controls.switchTorch(on)
        torchOn = on
        return true
      } catch {
        // iPhone Safari exposes no torch through getUserMedia for most devices; the toggle simply reports
        // that it is unavailable rather than pretending it worked.
        torchOn = false
        return false
      }
    },
  }
  void torchOn

  controls = await reader.decodeFromConstraints(
    // The rear camera is the one that points at a barcode; "environment" is ignored by desktop browsers.
    { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
    options.video,
    (result) => {
      if (stopped || !result) return
      options.onResult({ text: result.getText().trim(), format: String(result.getBarcodeFormat()) })
    },
  ).catch((error: unknown) => {
    options.onError(cameraErrorMessage(error))
    return null
  }) as IScannerControls | null

  if (controls === null) {
    stopped = true
    return handle
  }
  options.onReady?.()
  return handle
}
