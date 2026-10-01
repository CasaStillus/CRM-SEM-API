"use client"

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { TrendingDown, TrendingUp } from 'lucide-react'

import { APP_LOCALE } from '@/i18n/locale'
import { useAuth } from '@/hooks/use-auth'
import { seesAllConversations } from '@/lib/auth/roles'
import { formatCurrency } from '@/lib/currency'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import {
  conversionRate,
  loadSalesBySeller,
  percentChange,
  periodRange,
  totalsOf,
  visibleSellerRows,
  type SalesLoadResult,
  type SalesPeriod,
} from '@/lib/dashboard/sales'
import { Skeleton } from './skeleton'

const PERIODS: SalesPeriod[] = ['week', 'month', 'year']

interface PeriodData {
  current: SalesLoadResult
  previous: SalesLoadResult
}

/**
 * Revenue (won deals) for this week / month / year, compared with the
 * previous one, and conversion per seller. A seller sees only their
 * own numbers — the database applies the same rule.
 */
export function SalesPanel() {
  const t = useTranslations('Dashboard.sales')
  const { user, accountRole, defaultCurrency, profileLoading } = useAuth()
  const seesAll = accountRole ? seesAllConversations(accountRole) : false
  const userId = user?.id ?? null

  const [period, setPeriod] = useState<SalesPeriod>('month')
  const [cache, setCache] = useState<Partial<Record<SalesPeriod, PeriodData>>>({})
  const data = cache[period]

  useEffect(() => {
    if (profileLoading || cache[period]) return
    let cancelled = false
    const db = createClient()
    const range = periodRange(period)
    void Promise.all([
      loadSalesBySeller(db, range.from, range.to),
      loadSalesBySeller(db, range.prevFrom, range.prevTo),
    ]).then(([current, previous]) => {
      if (cancelled) return
      setCache((prev) => ({ ...prev, [period]: { current, previous } }))
    })
    return () => {
      cancelled = true
    }
  }, [period, cache, profileLoading])

  const view = (() => {
    if (!data || data.current.status !== 'ok') return null
    const viewer = { userId, seesAll }
    const rows = visibleSellerRows(data.current.rows, viewer)
    const totals = totalsOf(
      seesAll ? data.current.rows : rows,
    )
    const prevTotals =
      data.previous.status === 'ok'
        ? totalsOf(
            seesAll
              ? data.previous.rows
              : visibleSellerRows(data.previous.rows, viewer),
          )
        : null
    return { rows, totals, prevTotals }
  })()

  const money = (v: number) => formatCurrency(v, defaultCurrency)
  const pct = (v: number | null) =>
    v === null
      ? '—'
      : `${v.toLocaleString(APP_LOCALE, { maximumFractionDigits: 1 })}%`

  const change = view?.prevTotals
    ? percentChange(view.totals.revenue, view.prevTotals.revenue)
    : null

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {seesAll ? t('descriptionAll') : t('descriptionOwn')}
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                period === p
                  ? 'bg-secondary text-secondary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t(`period.${p}`)}
            </button>
          ))}
        </div>
      </header>

      <div className="p-5">
        {!data ? (
          <Skeleton className="h-[180px] w-full" />
        ) : data.current.status === 'migration_missing' ? (
          <p className="text-sm text-muted-foreground">{t('migrationMissing')}</p>
        ) : data.current.status === 'error' || !view ? (
          <p className="text-sm text-muted-foreground">{t('loadFailed')}</p>
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Stat label={t('revenue')} value={money(view.totals.revenue)}>
                {view.prevTotals && (
                  <span className="flex items-center gap-1">
                    {change !== null &&
                      (change >= 0 ? (
                        <TrendingUp className="h-3 w-3 text-emerald-500" />
                      ) : (
                        <TrendingDown className="h-3 w-3 text-rose-500" />
                      ))}
                    {t(`previous.${period}`, {
                      value: money(view.prevTotals.revenue),
                    })}
                  </span>
                )}
              </Stat>
              <Stat
                label={t('wonDeals')}
                value={view.totals.won.toLocaleString(APP_LOCALE)}
              >
                {t('lostDeals', { count: view.totals.lost })}
              </Stat>
              <Stat
                label={t('averageTicket')}
                value={
                  view.totals.won > 0
                    ? money(view.totals.revenue / view.totals.won)
                    : '—'
                }
              />
              <Stat
                label={t('conversion')}
                value={pct(conversionRate(view.totals.won, view.totals.leads))}
              >
                {t('leadsCount', { count: view.totals.leads })}
              </Stat>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">{t('seller')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('leads')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('won')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('lost')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('revenue')}</th>
                    <th className="py-2 pl-3 text-right font-medium">{t('conversion')}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.rows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-xs text-muted-foreground">
                        {t('empty')}
                      </td>
                    </tr>
                  ) : (
                    view.rows.map((r) => (
                      <tr
                        key={r.userId ?? 'unassigned'}
                        className="border-b border-border/60 last:border-0"
                      >
                        <td className="py-2 pr-3 text-foreground">
                          {r.userId === null
                            ? t('unassigned')
                            : r.name || t('unnamed')}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.leads}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.won}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.lost}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(r.revenue)}</td>
                        <td className="py-2 pl-3 text-right font-medium tabular-nums">
                          {pct(conversionRate(r.won, r.leads))}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-muted-foreground">{t('footnote')}</p>
          </div>
        )}
      </div>
    </section>
  )
}

function Stat({
  label,
  value,
  children,
}: {
  label: string
  value: string
  children?: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-border/70 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold text-foreground tabular-nums">
        {value}
      </div>
      {children && (
        <div className="mt-0.5 text-[11px] text-muted-foreground">{children}</div>
      )}
    </div>
  )
}
