import { describe, expect, it } from 'vitest'

import {
  bucketKeys,
  bucketLabel,
  customRange,
  dayKey,
  dealInRange,
  defaultUnit,
  fillSeries,
  presetRange,
  previousRange,
  unitAllowed,
} from './revenue'

// Thursday 1 Oct 2026, 15:00 local.
const NOW = new Date(2026, 9, 1, 15)

describe('presets', () => {
  it('this month covers the calendar month, half-open', () => {
    const r = presetRange('thisMonth', NOW)
    expect(dayKey(r.from)).toBe('2026-10-01')
    expect(dayKey(r.to)).toBe('2026-11-01')
  })

  it('last 7 days includes today', () => {
    const r = presetRange('7d', NOW)
    expect(dayKey(r.from)).toBe('2026-09-25')
    expect(dayKey(r.to)).toBe('2026-10-02')
  })

  it('this week starts on Monday', () => {
    expect(dayKey(presetRange('thisWeek', NOW).from)).toBe('2026-09-28')
  })

  it('a custom range includes both chosen days', () => {
    const r = customRange('2026-03-10', '2026-03-12')!
    expect(dayKey(r.from)).toBe('2026-03-10')
    expect(dayKey(r.to)).toBe('2026-03-13')
    expect(customRange('2026-03-12', '2026-03-10')).toBeNull()
    expect(customRange('', '2026-03-10')).toBeNull()
  })
})

describe('previous period', () => {
  it('this month compares with the whole previous month', () => {
    const p = previousRange(presetRange('thisMonth', NOW))
    expect([dayKey(p.from), dayKey(p.to)]).toEqual(['2026-09-01', '2026-10-01'])
  })

  it('a custom range compares with the same number of days before', () => {
    const p = previousRange(customRange('2026-03-10', '2026-03-12')!)
    expect([dayKey(p.from), dayKey(p.to)]).toEqual(['2026-03-07', '2026-03-10'])
  })
})

describe('buckets', () => {
  const r = customRange('2026-09-28', '2026-10-11')!

  it('splits a range by day, Monday weeks and months', () => {
    expect(bucketKeys(r.from, r.to, 'day')).toHaveLength(14)
    expect(bucketKeys(r.from, r.to, 'week')).toEqual(['2026-09-28', '2026-10-05'])
    expect(bucketKeys(r.from, r.to, 'month')).toEqual(['2026-09-01', '2026-10-01'])
  })

  it('fills empty buckets with zero', () => {
    const s = fillSeries([{ key: '2026-10-05', won: 2, revenue: 300 }], r.from, r.to, 'week')
    expect(s).toEqual([
      { key: '2026-09-28', won: 0, revenue: 0 },
      { key: '2026-10-05', won: 2, revenue: 300 },
    ])
  })

  it('"all time" starts at the first sale', () => {
    const all = presetRange('all', NOW)
    const s = fillSeries([{ key: '2026-08-01', won: 1, revenue: 10 }], all.from, all.to, 'month', true)
    expect(s.map((p) => p.key)).toEqual(['2026-08-01', '2026-09-01', '2026-10-01'])
  })

  it('refuses groupings that would draw too many bars', () => {
    const year = presetRange('thisYear', NOW)
    expect(unitAllowed(year.from, year.to, 'day')).toBe(false)
    expect(unitAllowed(year.from, year.to, 'week')).toBe(true)
    expect(defaultUnit(year)).toBe('month')
    expect(defaultUnit(presetRange('thisMonth', NOW))).toBe('day')
  })

  it('labels days and months', () => {
    expect(bucketLabel('2026-10-05', 'day')).toBe('05/10')
    expect(bucketLabel('2026-10-01', 'month')).toBe('out/26')
  })
})

describe('board filter', () => {
  const october = presetRange('thisMonth', NOW)
  it('keeps deals created or closed in the period', () => {
    expect(dealInRange({ created_at: '2026-10-03T12:00:00Z' }, october)).toBe(true)
    expect(
      dealInRange({ created_at: '2026-08-03T12:00:00Z', closed_at: '2026-10-02T12:00:00Z' }, october),
    ).toBe(true)
    expect(dealInRange({ created_at: '2026-08-03T12:00:00Z', closed_at: null }, october)).toBe(false)
    expect(dealInRange({ created_at: '2020-01-01T00:00:00Z' }, presetRange('all', NOW))).toBe(true)
  })
})
