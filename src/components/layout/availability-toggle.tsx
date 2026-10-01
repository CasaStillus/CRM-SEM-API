'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  loadOwnAvailability,
  setAvailability,
} from '@/lib/team/round-robin-client';

/**
 * The signed-in user's "available for new leads" state. Null until it
 * loads, and stays null when migration 053 has not been applied (the
 * column does not exist), which hides every control that uses it.
 */
export function useOwnAvailability(userId: string | null | undefined) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void loadOwnAvailability(userId).then((value) => {
      if (!cancelled) setAvailable(value);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  async function toggle(next: boolean) {
    if (!userId) return;
    setSaving(true);
    const ok = await setAvailability(userId, next);
    setSaving(false);
    if (ok) setAvailable(next);
  }

  return { available, saving, toggle };
}

/**
 * "Available for new leads" switch for the account menu. Off = the lead
 * rotation skips this person (day off, away).
 */
export function AvailabilityToggle({
  available,
  saving,
  onToggle,
}: {
  available: boolean;
  saving: boolean;
  onToggle: (next: boolean) => void;
}) {
  const t = useTranslations('Header');

  return (
    <div className="flex items-center justify-between gap-3 px-2 py-1.5">
      <div className="min-w-0">
        <p className="text-sm text-foreground">{t('availableForLeads')}</p>
        <p
          className={cn(
            'text-[11px]',
            available ? 'text-emerald-500' : 'text-amber-500'
          )}
        >
          {available ? t('availableOn') : t('availableOff')}
        </p>
      </div>
      <Switch
        checked={available}
        disabled={saving}
        onCheckedChange={(v) => onToggle(v)}
        aria-label={t('availableForLeads')}
      />
    </div>
  );
}
