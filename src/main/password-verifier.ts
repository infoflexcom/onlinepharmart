import { compare } from 'bcryptjs'

/**
 * The single bcrypt comparison used by both the desktop login and the phone login. bcrypt ignores bytes past
 * 72, so an over-long password is rejected outright rather than silently truncated and matched.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (typeof password !== 'string' || typeof hash !== 'string' || !hash) return false
  if (password.length > 72 || Buffer.byteLength(password, 'utf8') > 72) return false
  try {
    return await compare(password, hash)
  } catch {
    return false
  }
}
