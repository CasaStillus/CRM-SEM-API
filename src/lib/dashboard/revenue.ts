/**
 * Date range + grouping for revenue views (migration 057).
 *
 * Ranges are half-open: `from` inclusive, `to` exclusive, both at local
 * midnight. A custom range picked as "1 to 15 Oct" is stored as
 * [1 Oct 00:00, 16 Oct 00:00). Weeks start on Monday, matching the
 * database's `date_trunc('week')`.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type RangePreset =
  | 'today'
  | '7d'
  | '30d'
  | 'thisWeek'
  | 'thisMonth'
  | 'lastMonth'
  | 'thisYear'
  | 'all'
  | 'custom'

export type BucketUnit = 'day' | 'week' | 'month'

export interface DateRangeValue {
  preset: RangePreset
  from: Date
  to: Date
}

const DAY_MS = 86_400_000

function midnight(d: Date): Date {
  const out = new Date(d)
  out.setHours(0, 0, 0, 0)
  return out
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + n)
  return out
}

/** Earliest date "Tudo" reaches back to; the chart trims empty leading buckets. */
export const ALL_TIME_START = new Date(2000, 0, 1)

export function presetRange(
  preset: Exclude<RangePreset, 'custom'>,
  now: Date = new Date(),
): DateRangeValue {
  const today = midnight(now)
  const tomorrow = addDays(today, 1)
  switch (preset) {
    case 'today':
      return { preset, from: today, to: tomorrow }
    case '7d':
      return { preset, from: addDays(today, -6), to: tomorrow }
    case '30d':
      return { preset, from: addDays(today, -29), to: tomorrow }
    case 'thisWeek': {
      const from = addDays(today, -((today.getDay() + 6) % 7))
      return { preset, from, to: addDays(from, 7) }
    }
    case 'thisMonth': {
      const from = new Date(today.getFullYear(), today.getMonth(), 1)
      return { preset, from, to: new Date(today.getFullYear(), today.getMonth() + 1, 1) }
    }
    case 'lastMonth': {
      const from = new Date(today.getFullYear(), today.getMonth() - 1, 1)
      return { preset, from, to: new Date(today.getFullYear(), today.getMonth(), 1) }
    }
    case 'thisYear':
      return {
        preset,
        from: new Date(today.getFullYear(), 0, 1),
        to: new Date(today.getFullYear() + 1, 0, 1),
      }
    case 'all':
      return { preset, from: new Date(ALL_TIME_START), to: tomorrow }
  }
}

/** A custom range from two `YYYY-MM-DD` inputs, both days included. */
export function customRange(fromKey: string, toKey: string): DateRangeValue | null {
  const from = parseDayKey(fromKey)
  const toDay = parseDayKey(toKey)
  if (!from || !toDay || toDay < from) return null
  return { preset: 'custom', from, to: addDays(toDay, 1) }
}

/** The same length of time right before `range`, for comparison. */
export function previousRange(range: DateRangeValue): { from: Date; to: Date } {
  if (range.preset === 'thisMonth' || range.preset === 'lastMonth') {
    const from = new Date(range.from.getFullYear(), range.from.getMonth() - 1, 1)
    return { from, to: new Date(range.from) }
  }
  if (range.preset === 'thisYear') {
    return { from: new Date(range.from.getFullYear() - 1, 0, 1), to: new Date(range.from) }
  }
  const days = Math.round((range.to.getTime() - range.from.getTime()) / DAY_MS)
  return { from: addDays(range.from, -days), to: new Date(range.from) }
}

export function dayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function parseDayKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

export function bucketStart(d: Date, unit: BucketUnit): Date {
  const out = midnight(d)
  if (unit === 'week') return addDays(out, -((out.getDay() + 6) % 7))
  if (unit === 'month') return new Date(out.getFullYear(), out.getMonth(), 1)
  return out
}

function nextBucket(d: Date, unit: BucketUnit): Date {
  if (unit === 'day') return addDays(d, 1)
  if (unit === 'week') return addDays(d, 7)
  return new Date(d.getFullYear(), d.getMonth() + 1, 1)
}

/** Bucket start keys covering [from, to), oldest first. */
export function bucketKeys(from: Date, to: Date, unit: BucketUnit): string[] {
  const keys: string[] = []
  for (let b = bucketStart(from, unit); b < to; b = nextBucket(b, unit)) {
    keys.push(dayKey(b))
    if (keys.length > 5000) break
  }
  return keys
}

/** Most bars a chart shows before a grouping is offered as too fine. */
export const MAX_BUCKETS = 120

export function unitAllowed(from: Date, to: Date, unit: BucketUnit): boolean {
  return unit === 'month' || bucketKeys(from, to, unit).length <= MAX_BUCKETS
}

/** A sensible grouping for the range: days for a month, weeks for a quarter, then months. */
export function defaultUnit(range: DateRangeValue): BucketUnit {
  if (range.preset === 'all' || range.preset === 'thisYear') return 'month'
  const days = Math.round((range.to.getTime() - range.from.getTime()) / DAY_MS)
  if (days <= 45) return 'day'
  if (days <= 180) return 'week'
  return 'month'
}

export interface RevenuePoint {
  key: string
  won: number
  revenue: number
}

/**
 * Every bucket in the range, zero where nothing was won. For "Tudo",
 * the empty years before the first sale are left out.
 */
export function fillSeries(
  rows: RevenuePoint[],
  from: Date,
  to: Date,
  unit: BucketUnit,
  trimLeading = false,
): RevenuePoint[] {
  const byKey = new Map(rows.map((r) => [r.key, r]))
  let keys = bucketKeys(from, to, unit)
  if (trimLeading) {
    const first = keys.findIndex((k) => byKey.has(k))
    keys = first < 0 ? keys.slice(-1) : keys.slice(first)
  }
  return keys.map((key) => byKey.get(key) ?? { key, won: 0, revenue: 0 })
}

const MONTHS_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

/** Short axis label: "01/10" for a day or week start, "out/26" for a month. */
export function bucketLabel(key: string, unit: BucketUnit): string {
  const d = parseDayKey(key)
  if (!d) return key
  if (unit === 'month') {
    return `${MONTHS_PT[d.getMonth()]}/${String(d.getFullYear()).slice(-2)}`
  }
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
}

export type RevenueLoadResult =
  | { status: 'ok'; points: RevenuePoint[] }
  | { status: 'migration_missing' }
  | { status: 'error'; message: string }

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo'
  } catch {
    return 'America/Sao_Paulo'
  }
}

export async function loadRevenueByPeriod(
  db: SupabaseClient,
  range: { from: Date; to: Date },
  unit: BucketUnit,
  pipelineId?: string | null,
): Promise<RevenueLoadResult> {
  const { data, error } = await db.rpc('revenue_by_period', {
    p_from: range.from.toISOString(),
    p_to: range.to.toISOString(),
    p_bucket: unit,
    p_tz: browserTimeZone(),
    p_pipeline_id: pipelineId ?? null,
  })
  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') {
      return { status: 'migration_missing' }
    }
    return { status: 'error', message: error.message }
  }
  const points = ((data ?? []) as { bucket: string; won: number | string; revenue: number | string }[]).map(
    (r) => ({
      key: String(r.bucket).slice(0, 10),
      won: Number(r.won) || 0,
      revenue: Number(r.revenue) || 0,
    }),
  )
  return { status: 'ok', points }
}

/**
 * Whether a deal belongs on a board filtered to `range`: created in it,
 * or won/lost in it. "Tudo" shows everything.
 */
export function dealInRange(
  deal: { created_at?: string | null; closed_at?: string | null },
  range: DateRangeValue,
): boolean {
  if (range.preset === 'all') return true
  const inRange = (iso?: string | null) => {
    if (!iso) return false
    const t = Date.parse(iso)
    return !Number.isNaN(t) && t >= range.from.getTime() && t < range.to.getTime()
  }
  return inRange(deal.created_at) || inRange(deal.closed_at)
}
