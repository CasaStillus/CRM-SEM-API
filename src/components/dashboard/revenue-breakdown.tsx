"use client"

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import { APP_LOCALE } from '@/i18n/locale'
import { useAuth } from '@/hooks/use-auth'
import { formatCurrency } from '@/lib/currency'
import { createClient } from '@/lib/supabase/client'
import { BarChart } from '@/components/tremor/bar-chart'
import {
  bucketLabel,
  fillSeries,
  loadRevenueByPeriod,
  type BucketUnit,
  type DateRangeValue,
  type RevenueLoadResult,
} from '@/lib/dashboard/revenue'
import { Skeleton } from './skeleton'

/**
 * Revenue (won deals) in the range, one bar per day / week / month,
 * with the same numbers as a table one click away. Sellers see only
 * their own deals — the database applies that rule.
 */
export function RevenueBreakdown({
  range,
  unit,
  pipelineId,
  showTotals = true,
}: {
  range: DateRangeValue
  unit: BucketUnit
  pipelineId?: string | null
  showTotals?: boolean
}) {
  const t = useTranslations('Dashboard.revenue')
  const { defaultCurrency, profileLoading } = useAuth()
  const [result, setResult] = useState<{ key: string; data: RevenueLoadResult } | null>(null)

  const fromMs = range.from.getTime()
  const toMs = range.to.getTime()
  const requestKey = `${fromMs}|${toMs}|${unit}|${pipelineId ?? ''}`

  useEffect(() => {
    if (profileLoading) return
    let cancelled = false
    void loadRevenueByPeriod(
      createClient(),
      { from: new Date(fromMs), to: new Date(toMs) },
      unit,
      pipelineId,
    ).then((data) => {
      if (!cancelled) setResult({ key: requestKey, data })
    })
    return () => {
      cancelled = true
    }
  }, [fromMs, toMs, unit, pipelineId, requestKey, profileLoading])

  const money = (v: number) => formatCurrency(v, defaultCurrency)
  const loading = !result || result.key !== requestKey

  if (loading) return <Skeleton className="h-[260px] w-full" />
  if (result.data.status === 'migration_missing') {
    return <p className="text-sm text-muted-foreground">{t('migrationMissing')}</p>
  }
  if (result.data.status === 'error') {
    return <p className="text-sm text-muted-foreground">{t('loadFailed')}</p>
  }

  const series = fillSeries(
    result.data.points,
    range.from,
    range.to,
    unit,
    range.preset === 'all',
  )
  const total = series.reduce((s, p) => s + p.revenue, 0)
  const won = series.reduce((s, p) => s + p.won, 0)
  const best = series.reduce<(typeof series)[number] | null>(
    (b, p) => (p.revenue > 0 && (!b || p.revenue > b.revenue) ? p : b),
    null,
  )
  const category = t('revenue')
  const chartData = series.map((p) => ({
    label: bucketLabel(p.key, unit),
    [category]: p.revenue,
  }))

  return (
    <div className="space-y-4">
      {showTotals && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Total label={t('revenue')} value={money(total)} />
          <Total label={t('sales')} value={won.toLocaleString(APP_LOCALE)} />
          <Total label={t('averageTicket')} value={won > 0 ? money(total / won) : '—'} />
          <Total
            label={t(`best.${unit}`)}
            value={best ? bucketLabel(best.key, unit) : '—'}
            hint={best ? money(best.revenue) : undefined}
          />
        </div>
      )}

      {total === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <BarChart
          data={chartData}
          index="label"
          categories={[category]}
          colors={['emerald']}
          valueFormatter={money}
          showLegend={false}
          yAxisWidth={84}
          className="h-[260px]"
        />
      )}

      <details className="group text-sm">
        <summary className="cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground">
          {t('showTable')}
        </summary>
        <div className="mt-2 max-h-72 overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">{t(`column.${unit}`)}</th>
                <th className="px-3 py-2 text-right font-medium">{t('sales')}</th>
                <th className="py-2 pl-3 text-right font-medium">{t('revenue')}</th>
              </tr>
            </thead>
            <tbody>
              {[...series].reverse().map((p) => (
                <tr key={p.key} className="border-b border-border/60 last:border-0">
                  <td className="py-1.5 pr-3 text-foreground">
                    {unit === 'week' ? t('weekOf', { date: bucketLabel(p.key, unit) }) : bucketLabel(p.key, unit)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{p.won}</td>
                  <td className="py-1.5 pl-3 text-right tabular-nums">{money(p.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

function Total({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border/70 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold text-foreground tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  )
}
