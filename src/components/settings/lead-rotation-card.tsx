'use client';

import { useEffect, useState } from 'react';
import { Shuffle } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/use-auth';
import {
  loadRotationMembers,
  setAvailability,
  setInRotation,
  type RotationMember,
} from '@/lib/team/round-robin-client';

/**
 * Admin view of the lead rotation: who is in it and who is available
 * right now. New leads go, in turn, to members that are both.
 */
export function LeadRotationCard() {
  const t = useTranslations('Settings.leadRotation');
  const { accountId } = useAuth();
  const [members, setMembers] = useState<RotationMember[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void loadRotationMembers(accountId).then((result) => {
      if (cancelled) return;
      if (result.status === 'migration_missing') setMissing(true);
      else if (result.status === 'ok') setMembers(result.members);
      else toast.error(t('loadFailed'));
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, t]);

  async function toggle(
    member: RotationMember,
    field: 'round_robin_enabled' | 'is_available',
    value: boolean
  ) {
    setBusy(`${member.user_id}:${field}`);
    const ok =
      field === 'round_robin_enabled'
        ? await setInRotation(member.user_id, value)
        : await setAvailability(member.user_id, value);
    setBusy(null);
    if (!ok) {
      toast.error(t('saveFailed'));
      return;
    }
    setMembers((prev) =>
      (prev ?? []).map((m) =>
        m.user_id === member.user_id ? { ...m, [field]: value } : m
      )
    );
  }

  const receiving = (members ?? []).filter(
    (m) => m.round_robin_enabled && m.is_available
  ).length;

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <Shuffle className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t('description')}</p>

      <Card>
        <CardContent className="p-0">
          {missing ? (
            <p className="p-4 text-sm text-muted-foreground">
              {t('migrationMissing')}
            </p>
          ) : members === null ? (
            <p className="p-4 text-sm text-muted-foreground">{t('loading')}</p>
          ) : (
            <>
              <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-6 border-b border-border px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <span>{t('member')}</span>
                <span className="w-20 text-center">{t('inRotation')}</span>
                <span className="w-20 text-center">{t('available')}</span>
              </div>
              <ul className="divide-y divide-border">
                {members.map((m) => (
                  <li
                    key={m.user_id}
                    className="grid grid-cols-[1fr_auto_auto] items-center gap-x-6 px-4 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-foreground">
                        {m.full_name || t('unnamed')}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {m.round_robin_enabled && m.is_available
                          ? t('statusReceiving')
                          : m.round_robin_enabled
                            ? t('statusUnavailable')
                            : t('statusOut')}
                      </p>
                    </div>
                    <div className="flex w-20 justify-center">
                      <Switch
                        checked={m.round_robin_enabled}
                        disabled={busy !== null}
                        onCheckedChange={(v) => void toggle(m, 'round_robin_enabled', v)}
                        aria-label={t('inRotation')}
                      />
                    </div>
                    <div className="flex w-20 justify-center">
                      <Switch
                        checked={m.is_available}
                        disabled={busy !== null}
                        onCheckedChange={(v) => void toggle(m, 'is_available', v)}
                        aria-label={t('available')}
                      />
                    </div>
                  </li>
                ))}
              </ul>
              <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
                {receiving > 0
                  ? t('summary', { count: receiving })
                  : t('summaryNobody')}
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
