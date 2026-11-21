/**
 * The relay's wire protocol now lives in `src/shared/relay/protocol.ts`, because the desktop host speaks the
 * same frames. This file stays so the cloud's own imports (and the cloud tests) keep one stable path.
 */
export * from '../../../src/shared/relay/protocol'
