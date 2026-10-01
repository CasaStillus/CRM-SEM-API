/**
 * Revenue per period and conversion per seller (migration 056).
 *
 * Revenue is the sum of WON deals whose `closed_at` falls in the
 * period. Conversion is won deals ÷ new leads (conversations, groups
 * left out) in the same period. Period boundaries are local calendar
 * boundaries — "this week" starts Monday 00:00 where the user is.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type SalesPeriod = 'week' | 'month' | 'year'

export interface PeriodRange {
  from: Date
  to: Date
  prevFrom: Date
  prevTo: Date
}

export function periodRange(period: SalesPeriod, now: Date = new Date()): PeriodRange {
  const from = new Date(now)
  from.setHours(0, 0, 0, 0)

  if (period === 'week') {
    // Monday-first, matching the rest of the dashboard.
    const offset = (from.getDay() + 6) % 7
    from.setDate(from.getDate() - offset)
    const to = new Date(from)
    to.setDate(to.getDate() + 7)
    const prevFrom = new Date(from)
    prevFrom.setDate(prevFrom.getDate() - 7)
    return { from, to, prevFrom, prevTo: new Date(from) }
  }

  if (period === 'month') {
    from.setDate(1)
    const to = new Date(from)
    to.setMonth(to.getMonth() + 1)
    const prevFrom = new Date(from)
    prevFrom.setMonth(prevFrom.getMonth() - 1)
    return { from, to, prevFrom, prevTo: new Date(from) }
  }

  from.setMonth(0, 1)
  const to = new Date(from)
  to.setFullYear(to.getFullYear() + 1)
  const prevFrom = new Date(from)
  prevFrom.setFullYear(prevFrom.getFullYear() - 1)
  return { from, to, prevFrom, prevTo: new Date(from) }
}

export interface SellerSales {
  /** Null for the "no owner" row. */
  userId: string | null
  name: string | null
  leads: number
  won: number
  lost: number
  revenue: number
}

export interface SalesTotals {
  leads: number
  won: number
  lost: number
  revenue: number
}

export type SalesLoadResult =
  | { status: 'ok'; rows: SellerSales[] }
  | { status: 'migration_missing' }
  | { status: 'error'; message: string }

interface RawRow {
  user_id: string | null
  full_name: string | null
  leads: number | string
  won: number | string
  lost: number | string
  revenue: number | string
}

export async function loadSalesBySeller(
  db: SupabaseClient,
  from: Date,
  to: Date,
): Promise<SalesLoadResult> {
  const { data, error } = await db.rpc('sales_by_seller', {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  })
  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') {
      return { status: 'migration_missing' }
    }
    return { status: 'error', message: error.message }
  }
  const rows = ((data ?? []) as RawRow[]).map((r) => ({
    userId: r.user_id,
    name: r.full_name,
    leads: Number(r.leads) || 0,
    won: Number(r.won) || 0,
    lost: Number(r.lost) || 0,
    revenue: Number(r.revenue) || 0,
  }))
  return { status: 'ok', rows }
}

export function totalsOf(rows: SellerSales[]): SalesTotals {
  return rows.reduce<SalesTotals>(
    (acc, r) => ({
      leads: acc.leads + r.leads,
      won: acc.won + r.won,
      lost: acc.lost + r.lost,
      revenue: acc.revenue + r.revenue,
    }),
    { leads: 0, won: 0, lost: 0, revenue: 0 },
  )
}

/** Won ÷ leads as a 0–100 percentage, or null when there were no leads. */
export function conversionRate(won: number, leads: number): number | null {
  if (leads <= 0) return null
  return (won / leads) * 100
}

/** Percentage change from `previous` to `current`, or null when not meaningful. */
export function percentChange(current: number, previous: number): number | null {
  if (previous <= 0) return null
  return ((current - previous) / previous) * 100
}

/**
 * Rows worth showing, best first. A seller sees only their own line; a
 * manager sees everyone with any activity, and the "no owner" line only
 * when something is unassigned.
 */
export function visibleSellerRows(
  rows: SellerSales[],
  viewer: { userId: string | null; seesAll: boolean },
): SellerSales[] {
  const active = (r: SellerSales) => r.leads + r.won + r.lost > 0
  const picked = viewer.seesAll
    ? rows.filter(active)
    : rows.filter((r) => r.userId !== null && r.userId === viewer.userId)
  return [...picked].sort(
    (a, b) =>
      b.revenue - a.revenue ||
      b.won - a.won ||
      b.leads - a.leads ||
      (a.userId === null ? 1 : 0) - (b.userId === null ? 1 : 0),
  )
}
