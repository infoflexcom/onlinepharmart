#!/usr/bin/env node
/**
 * The executable entry point for the installer's PBKDF2/checksum helper.
 *
 * Built with `node --experimental-sea-config` or bundled by `pkg`/`nexe` into `password-check.exe` for the NSIS
 * payload. Kept as a thin wrapper so `password-check.ts` stays pure and directly testable.
 */
import { runPasswordCheck } from './password-check'

const result = runPasswordCheck(process.argv.slice(2))
if (result.message) process.stderr.write(`${result.message}\r\n`)
process.exit(result.code)
