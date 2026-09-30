'use client';

import { useState } from 'react';
import { ExternalLink, Megaphone } from 'lucide-react';
import type { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import type { MessageAdReferral } from '@/types';

/**
 * The click-to-WhatsApp ad a lead tapped, drawn the way the phone draws
 * it above their first message: headline and text on the left, the ad's
 * photo on the right, a thin accent bar along the edge.
 *
 * When the provider only said "this came from an ad" without sending
 * the card itself, a small label is shown instead, so the agent still
 * knows where the lead came from.
 */
export function AdReferralCard({
  referral,
  t,
}: {
  referral: MessageAdReferral;
  t: ReturnType<typeof useTranslations>;
}) {
  const [imageBroken, setImageBroken] = useState(false);

  const thumbnail = !imageBroken ? referral.thumbnail_url : null;
  const hasCard = Boolean(referral.title || referral.body || thumbnail);
  const label =
    referral.source_type === 'post' ? t('adReferralPost') : t('adReferralAd');

  if (!hasCard) {
    return (
      <span className="text-primary bg-primary/10 mb-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium">
        <Megaphone className="h-3 w-3" />
        {t('adReferralFromAd')}
      </span>
    );
  }

  const card = (
    <div
      className={cn(
        'border-primary bg-background/70 mb-1.5 flex max-w-[320px] gap-2 overflow-hidden rounded-lg border-l-4 p-2',
        referral.source_url && 'hover:bg-background transition-colors'
      )}
    >
      <div className="min-w-0 flex-1">
        <span className="text-primary inline-flex items-center gap-1 text-[10px] font-semibold tracking-wide uppercase">
          <Megaphone className="h-3 w-3" />
          {label}
        </span>
        {referral.title && (
          <p className="text-foreground mt-0.5 line-clamp-2 text-xs font-semibold">
            {referral.title}
          </p>
        )}
        {referral.body && (
          <p className="text-muted-foreground mt-0.5 line-clamp-3 text-xs">
            {referral.body}
          </p>
        )}
        {referral.source_url && (
          <span className="text-primary mt-1 inline-flex items-center gap-1 text-[10px] font-medium">
            <ExternalLink className="h-3 w-3" />
            {t('adReferralOpen')}
          </span>
        )}
      </div>
      {thumbnail && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumbnail}
          alt={referral.title ?? label}
          className="h-16 w-16 shrink-0 rounded-md object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setImageBroken(true)}
        />
      )}
    </div>
  );

  if (!referral.source_url) return card;

  return (
    <a
      href={referral.source_url}
      target="_blank"
      rel="noopener noreferrer"
      className="block"
      title={t('adReferralOpen')}
    >
      {card}
    </a>
  );
}
