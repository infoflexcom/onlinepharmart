/**
 * The database-ownership rule, as a pure predicate.
 *
 * The architecture rests on one sentence: **only the server process opens the database file.** If a client can open
 * it, two writers exist, the single-writer assumption behind every transaction is false, and the permission table
 * is decoration. So the rule is checked mechanically rather than trusted.
 *
 * This module holds no I/O: it takes file paths and source text and returns findings. That keeps it testable, and it
 * means the same predicate can be called by a test, by a release check, or by an editor plugin without any of them
 * disagreeing about what the rule is.
 *
 * ## What counts as opening the database
 *
 * - Importing the database module itself (`src/db`, `src/db/index`, or a relative path resolving to it).
 * - Importing `better-sqlite3`, which is the only way to open a SQLite file in this product.
 *
 * Both are needed. A client that imports `better-sqlite3` directly never touches the `src/db` module and would slip
 * past a check that only looked for the module.
 *
 * ## Which files are allowed to
 *
 * The server side of the product, named by directory rather than by a list of files. A list of files would have to
 * be updated whenever a service is added, and the day somebody forgets is the day a client gets a database handle.
 */

/** Directories whose code runs in the server process and may own the database. */
export const SERVER_DIRECTORIES = [
  'src/db/',
  'src/services/',
  'src/license/',
  'src/api/',
  'src/main/',
  'src/shared/',
  'src/currency/',
  'src/editions/',
  'cloud/',
  'buildstudio/',
] as const

/**
 * Directories whose code runs in a client and must never reach the database.
 *
 * `src/renderer/` is the desktop window. `src/preload/` is the bridge it holds. `mobile/` is the phone app. These
 * are the clients that exist today; when `/apps/client` is created it joins this list.
 */
export const CLIENT_DIRECTORIES = ['src/renderer/', 'src/preload/', 'mobile/src/', 'packages/core/'] as const

/** Modules whose mere import means "this file can open the database". */
const DATABASE_MODULES = [/^better-sqlite3$/, /^(\.\.?\/)*db(\/index)?$/, /^(\.\.?\/)+db$/, /^@server\/db$/]

export interface OwnershipFinding {
  file: string
  specifier: string
  why: string
}

/** True when a path is inside one of the given directory prefixes. */
export function inDirectories(file: string, directories: readonly string[]): boolean {
  const normalised = file.replace(/\\/gu, '/').replace(/^\.\//u, '')
  return directories.some((directory) => normalised === directory.slice(0, -1) || normalised.startsWith(directory))
}

/** Every module specifier in a source file. Shared with the surface scanner's reading philosophy: text, not imports. */
export function moduleSpecifiers(source: string): string[] {
  return [
    ...[...source.matchAll(/\bfrom\s*'([^']+)'/gu)].map((match) => match[1]!),
    ...[...source.matchAll(/\bimport\s*\(\s*'([^']+)'/gu)].map((match) => match[1]!),
    ...[...source.matchAll(/\bimport\s+'([^']+)'/gu)].map((match) => match[1]!),
    ...[...source.matchAll(/\brequire\(\s*'([^']+)'/gu)].map((match) => match[1]!),
  ]
}

function databaseImport(specifier: string): string | null {
  if (/^better-sqlite3$/u.test(specifier)) return 'it imports better-sqlite3, the SQLite driver'
  // A relative import that ends at a `db` directory or module.
  if (/(?:^|\/)db(?:\/index)?$/u.test(specifier) && specifier.startsWith('.')) {
    return 'it imports the database module'
  }
  if (DATABASE_MODULES.some((pattern) => pattern.test(specifier)) && specifier === 'better-sqlite3') {
    return 'it imports better-sqlite3, the SQLite driver'
  }
  return null
}

/**
 * Find every client-side file that can open the database.
 *
 * `files` is a map of repository-relative path → source text. A test supplies it from the tree; a release check
 * supplies it from `git ls-files` and the working copy. Neither is a hand-kept list of suspects.
 */
export function findClientDatabaseAccess(files: ReadonlyMap<string, string>): OwnershipFinding[] {
  const findings: OwnershipFinding[] = []
  for (const [file, source] of files) {
    if (!inDirectories(file, CLIENT_DIRECTORIES)) continue
    // Tests may legitimately open an in-memory database to exercise a client's pure logic; they are not shipped.
    if (/\.test\.tsx?$/u.test(file)) continue
    for (const specifier of moduleSpecifiers(source)) {
      const why = databaseImport(specifier)
      if (why) findings.push({ file, specifier, why })
    }
  }
  return findings
}

/**
 * Find database access from a file that is in *neither* list.
 *
 * A new top-level directory that imports the database is not automatically a violation — it might be a new server
 * module somebody forgot to classify. But it must not be silently ignored either, because "not on the client list"
 * is not the same as "allowed". So it is reported as *unclassified*, and the test fails until somebody says which
 * side of the line it is on.
 */
export function findUnclassifiedDatabaseAccess(files: ReadonlyMap<string, string>): OwnershipFinding[] {
  const findings: OwnershipFinding[] = []
  for (const [file, source] of files) {
    if (inDirectories(file, SERVER_DIRECTORIES) || inDirectories(file, CLIENT_DIRECTORIES)) continue
    if (/\.test\.tsx?$/u.test(file)) continue
    for (const specifier of moduleSpecifiers(source)) {
      const why = databaseImport(specifier)
      if (why) findings.push({ file, specifier, why })
    }
  }
  return findings
}
