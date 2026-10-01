import { describe, expect, it } from 'vitest'

import {
  conversionRate,
  percentChange,
  periodRange,
  totalsOf,
  visibleSellerRows,
  type SellerSales,
} from './sales'

// Thursday 1 Oct 2026, 15:00 local time.
const NOW = new Date(2026, 9, 1, 15, 0, 0)
const ymd = (d: Date) => [d.getFullYear(), d.getMonth() + 1, d.getDate()]

describe('periodRange', () => {
  it('week starts on Monday and compares with the previous week', () => {
    const r = periodRange('week', NOW)
    expect(ymd(r.from)).toEqual([2026, 9, 28])
    expect(ymd(r.to)).toEqual([2026, 10, 5])
    expect(ymd(r.prevFrom)).toEqual([2026, 9, 21])
    expect(r.prevTo.getTime()).toBe(r.from.getTime())
    expect(r.from.getHours()).toBe(0)
  })

  it('month covers the calendar month', () => {
    const r = periodRange('month', NOW)
    expect(ymd(r.from)).toEqual([2026, 10, 1])
    expect(ymd(r.to)).toEqual([2026, 11, 1])
    expect(ymd(r.prevFrom)).toEqual([2026, 9, 1])
  })

  it('year covers the calendar year', () => {
    const r = periodRange('year', NOW)
    expect(ymd(r.from)).toEqual([2026, 1, 1])
    expect(ymd(r.to)).toEqual([2027, 1, 1])
    expect(ymd(r.prevFrom)).toEqual([2025, 1, 1])
  })

  it('a Sunday still belongs to the week that started on Monday', () => {
    const r = periodRange('week', new Date(2026, 9, 4, 23, 0))
    expect(ymd(r.from)).toEqual([2026, 9, 28])
  })
})

const row = (p: Partial<SellerSales>): SellerSales => ({
  userId: 'u',
  name: 'n',
  leads: 0,
  won: 0,
  lost: 0,
  revenue: 0,
  ...p,
})

describe('sales numbers', () => {
  const rows = [
    row({ userId: 'ana', leads: 10, won: 2, revenue: 3000 }),
    row({ userId: 'bia', leads: 5, won: 3, lost: 1, revenue: 4500 }),
    row({ userId: 'caio' }),
    row({ userId: null, name: null, leads: 2 }),
  ]

  it('conversion is won over leads', () => {
    expect(conversionRate(2, 10)).toBe(20)
    expect(conversionRate(1, 0)).toBeNull()
  })

  it('compares with the previous period', () => {
    expect(percentChange(150, 100)).toBe(50)
    expect(percentChange(10, 0)).toBeNull()
  })

  it('adds up the team', () => {
    expect(totalsOf(rows)).toEqual({ leads: 17, won: 5, lost: 1, revenue: 7500 })
  })

  it('a manager sees everyone with activity, best seller first, no-owner last', () => {
    expect(
      visibleSellerRows(rows, { userId: 'adm', seesAll: true }).map((r) => r.userId),
    ).toEqual(['bia', 'ana', null])
  })

  it('a seller sees only their own line', () => {
    expect(
      visibleSellerRows(rows, { userId: 'ana', seesAll: false }).map((r) => r.userId),
    ).toEqual(['ana'])
    expect(visibleSellerRows(rows, { userId: 'caio', seesAll: false })).toHaveLength(1)
  })
})
