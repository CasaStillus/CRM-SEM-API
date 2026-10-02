"use client"

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { CalendarDays } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  customRange,
  dayKey,
  defaultUnit,
  presetRange,
  unitAllowed,
  type BucketUnit,
  type DateRangeValue,
  type RangePreset,
} from '@/lib/dashboard/revenue'

const PRESETS: RangePreset[] = [
  'today',
  '7d',
  '30d',
  'thisWeek',
  'thisMonth',
  'lastMonth',
  'thisYear',
  'all',
  'custom',
]

const UNITS: BucketUnit[] = ['day', 'week', 'month']

const CONTROL =
  'h-8 rounded-md border border-border bg-muted px-2 text-xs text-foreground focus:border-primary focus:outline-none'

/**
 * Period picker (shortcuts or any two dates) plus the grouping of the
 * revenue chart (day / week / month). Controlled: the parent owns the
 * range and the grouping.
 */
export function DateRangeFilter({
  range,
  unit,
  onChange,
  presets = PRESETS,
}: {
  range: DateRangeValue
  unit: BucketUnit
  onChange: (range: DateRangeValue, unit: BucketUnit) => void
  presets?: RangePreset[]
}) {
  const t = useTranslations('Dashboard.dateRange')
  // Inclusive end shown in the inputs; the range itself ends at midnight after.
  const [fromKey, setFromKey] = useState(dayKey(range.from))
  const [toKey, setToKey] = useState(
    dayKey(new Date(range.to.getTime() - 86_400_000)),
  )

  const pickUnit = (next: DateRangeValue, wanted: BucketUnit): BucketUnit =>
    unitAllowed(next.from, next.to, wanted) ? wanted : defaultUnit(next)

  const choosePreset = (preset: RangePreset) => {
    if (preset === 'custom') {
      const next = customRange(fromKey, toKey) ?? { ...range, preset: 'custom' as const }
      onChange(next, pickUnit(next, unit))
      return
    }
    const next = presetRange(preset)
    setFromKey(dayKey(next.from))
    setToKey(dayKey(new Date(next.to.getTime() - 86_400_000)))
    onChange(next, defaultUnit(next))
  }

  const applyCustom = (nextFrom: string, nextTo: string) => {
    setFromKey(nextFrom)
    setToKey(nextTo)
    const next = customRange(nextFrom, nextTo)
    if (next) onChange(next, pickUnit(next, defaultUnit(next)))
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CalendarDays className="h-3.5 w-3.5" />
        <span className="sr-only">{t('period')}</span>
        <select
          value={range.preset}
          onChange={(e) => choosePreset(e.target.value as RangePreset)}
          className={CONTROL}
          aria-label={t('period')}
        >
          {presets.map((p) => (
            <option key={p} value={p}>
              {t(`presets.${p}`)}
            </option>
          ))}
        </select>
      </label>

      {range.preset === 'custom' && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="date"
            value={fromKey}
            max={toKey}
            onChange={(e) => applyCustom(e.target.value, toKey)}
            className={CONTROL}
            aria-label={t('from')}
          />
          <span>{t('to')}</span>
          <input
            type="date"
            value={toKey}
            min={fromKey}
            onChange={(e) => applyCustom(fromKey, e.target.value)}
            className={CONTROL}
            aria-label={t('until')}
          />
        </div>
      )}

      <div
        className="flex items-center gap-1 rounded-lg bg-muted/60 p-1"
        role="group"
        aria-label={t('groupBy')}
      >
        {UNITS.map((u) => {
          const allowed = unitAllowed(range.from, range.to, u)
          return (
            <button
              key={u}
              type="button"
              disabled={!allowed}
              title={allowed ? undefined : t('tooMany')}
              onClick={() => onChange(range, u)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                unit === u
                  ? 'bg-secondary text-secondary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t(`units.${u}`)}
            </button>
          )
        })}
      </div>
    </div>
  )
}
