/**
 * Inbox list filters, sort and the per-person unread count.
 *
 * Pure functions so the rules are tested once and the list component
 * only wires them to dropdowns.
 */

import type { Conversation, ConversationStatus } from '@/types';

export type InboxStatusFilter =
  | ConversationStatus
  | 'all'
  | 'unread'
  | 'awaiting_reply';

export type InboxSort = 'recent' | 'oldest';

export type InboxPeriod = 'any' | '7d' | '30d';

const DAY_MS = 24 * 60 * 60 * 1000;

const PERIOD_DAYS: Record<Exclude<InboxPeriod, 'any'>, number> = {
  '7d': 7,
  '30d': 30,
};

export interface InboxViewer {
  userId: string | null;
  /** Owner, admin or viewer: sees conversations that belong to others. */
  seesAll: boolean;
}

/**
 * The unread count this person should see.
 *
 * `unread_count` belongs to whoever is responsible for the conversation
 * (the seller it is assigned to, or the team while it has no owner).
 * Someone looking at a conversation assigned to another person — an
 * admin following a seller — has a count of their own
 * (`viewer_unread`, migration 055), so each sees their own blue dot.
 */
export function unreadFor(conv: Conversation, viewer: InboxViewer): number {
  const owner = conv.assigned_agent_id ?? null;
  const someoneElses = owner !== null && owner !== viewer.userId;
  if (viewer.seesAll && someoneElses) return conv.viewer_unread ?? 0;
  return conv.unread_count ?? 0;
}

/** The customer wrote last and nobody has answered yet. */
export function isAwaitingReply(conv: Conversation): boolean {
  return conv.last_message_sender === 'customer';
}

function lastActivity(conv: Conversation): number {
  const at = conv.last_message_at ?? conv.updated_at ?? conv.created_at;
  const ms = at ? Date.parse(at) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

export function applyInboxFilters(
  conversations: Conversation[],
  options: {
    status: InboxStatusFilter;
    sort: InboxSort;
    period: InboxPeriod;
    viewer: InboxViewer;
    now?: number;
  }
): Conversation[] {
  const { status, sort, period, viewer } = options;
  const now = options.now ?? Date.now();

  let result = conversations;

  if (status === 'unread') {
    result = result.filter((c) => unreadFor(c, viewer) > 0);
  } else if (status === 'awaiting_reply') {
    result = result.filter(isAwaitingReply);
  } else if (status !== 'all') {
    result = result.filter((c) => c.status === status);
  }

  if (period !== 'any') {
    const since = now - PERIOD_DAYS[period] * DAY_MS;
    result = result.filter((c) => lastActivity(c) >= since);
  }

  const direction = sort === 'oldest' ? 1 : -1;
  return [...result].sort(
    (a, b) => direction * (lastActivity(a) - lastActivity(b))
  );
}
