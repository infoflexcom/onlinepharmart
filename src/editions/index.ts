export const EDITIONS = ['PHARMACY', 'SUPERMARKET', 'BOTH'] as const
export type Edition = (typeof EDITIONS)[number]

export type EditionModule = 'pharmacy' | 'supermarket'

export function isEdition(value: unknown): value is Edition {
  return typeof value === 'string' && (EDITIONS as readonly string[]).includes(value)
}

/** License verification must happen in the host before resolving edition modules. */
export function isEditionEnabled(edition: Edition, module: EditionModule): boolean {
  return edition === 'BOTH' || edition === module.toUpperCase()
}
