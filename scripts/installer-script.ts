import { writeGeneratedIncludes } from '../installer/src/write-installer-script'

const directory = process.argv[2] ?? 'installer/nsis'
for (const written of writeGeneratedIncludes(directory)) {
  console.log(`Wrote ${written.path} (${written.bytes} bytes).`)
}
