const DATE_INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u
const MAX_DATE_YEAR = 9999
export const MAX_CONFIGURABLE_PERIOD_YEARS = 50

export function isValidDateInput(value: string): boolean {
  const match = DATE_INPUT_PATTERN.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12 || day < 1) return false
  return day <= daysInMonth(year, month)
}

/** Calendar terms clamp leap-day renewals to the final valid day of February. */
export function addYearsToDateInput(value: string, years: number): string {
  if (!isValidDateInput(value)) throw new Error('Enter a valid licence date.')
  if (!Number.isInteger(years) || years < 0) throw new Error('The licence term must be a whole number of years.')
  const match = DATE_INPUT_PATTERN.exec(value)!
  const year = Number(match[1]) + years
  if (year > MAX_DATE_YEAR) throw new Error('The licence date is outside the supported calendar range.')
  const month = Number(match[2])
  const day = Math.min(Number(match[3]), daysInMonth(year, month))
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function todayDateInput(now: Date | number = new Date()): string {
  const date = typeof now === 'number' ? new Date(now) : now
  if (!Number.isFinite(date.getTime())) throw new Error('The system date is unavailable.')
  return date.toISOString().slice(0, 10)
}

/** Licence dates are interpreted as midnight UTC; the end date is exclusive. */
export function dateInputToUtc(value: string): string {
  if (!isValidDateInput(value)) throw new Error('Enter a valid licence date.')
  return `${value}T00:00:00.000Z`
}

export function utcToDateInput(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('The saved licence date is invalid.')
  return date.toISOString().slice(0, 10)
}

export function assertLicensePeriod(startsOn: string, endsOn: string, maximumYears: number | null): void {
  if (!isValidDateInput(startsOn) || !isValidDateInput(endsOn)) throw new Error('Choose valid start and end dates.')
  if (endsOn < startsOn) throw new Error('The licence end date cannot be before its start date.')
  if (maximumYears === null) return
  if (!Number.isInteger(maximumYears) || maximumYears < 1 || maximumYears > MAX_CONFIGURABLE_PERIOD_YEARS) {
    throw new Error('The configured on-site licence period is invalid.')
  }
  const latestAllowedEnd = addYearsToDateInput(startsOn, maximumYears)
  if (endsOn > latestAllowedEnd) {
    throw new Error(`The configured maximum on-site period is ${maximumYears} years.`)
  }
}

export function isLicenseDateActive(startsAt: string, endsAt: string, now: number): 'active' | 'not_yet_valid' | 'expired' {
  const starts = Date.parse(startsAt)
  const ends = Date.parse(endsAt)
  if (!Number.isFinite(starts) || !Number.isFinite(ends) || ends < starts) return 'expired'
  if (now < starts) return 'not_yet_valid'
  // The end instant is exclusive: a licence whose end date is today locks at midnight UTC.
  if (now >= ends) return 'expired'
  return 'active'
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}
