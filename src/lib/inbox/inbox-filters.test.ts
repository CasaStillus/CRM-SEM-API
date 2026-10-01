import { describe, expect, it } from 'vitest';

import type { Conversation } from '@/types';

import { applyInboxFilters, isAwaitingReply, unreadFor } from './inbox-filters';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function conv(id: string, patch: Partial<Conversation> = {}): Conversation {
  return {
    id,
    user_id: 'u',
    contact_id: 'c',
    status: 'open',
    unread_count: 0,
    created_at: daysAgo(100),
    updated_at: daysAgo(100),
    ...patch,
  };
}

const admin = { userId: 'admin', seesAll: true };
const seller = { userId: 'seller', seesAll: false };

describe('unreadFor', () => {
  it('shows the shared count to the person responsible', () => {
    const c = conv('1', { assigned_agent_id: 'seller', unread_count: 3, viewer_unread: 1 });
    expect(unreadFor(c, seller)).toBe(3);
  });

  it("shows an admin their own count on a seller's conversation", () => {
    const c = conv('1', { assigned_agent_id: 'seller', unread_count: 3, viewer_unread: 1 });
    expect(unreadFor(c, admin)).toBe(1);
    expect(unreadFor(conv('2', { assigned_agent_id: 'seller', unread_count: 3 }), admin)).toBe(0);
  });

  it('uses the shared count for unassigned or own conversations', () => {
    expect(unreadFor(conv('1', { unread_count: 2, viewer_unread: 9 }), admin)).toBe(2);
    expect(
      unreadFor(conv('2', { assigned_agent_id: 'admin', unread_count: 4 }), admin)
    ).toBe(4);
  });
});

describe('applyInboxFilters', () => {
  const list = [
    conv('new', { last_message_at: daysAgo(1), last_message_sender: 'customer', unread_count: 2 }),
    conv('mid', { last_message_at: daysAgo(10), last_message_sender: 'agent' }),
    conv('old', { last_message_at: daysAgo(60), last_message_sender: 'customer', unread_count: 1, status: 'closed' }),
  ];
  const base = { status: 'all' as const, sort: 'recent' as const, period: 'any' as const, viewer: seller, now: NOW };
  const ids = (cs: Conversation[]) => cs.map((c) => c.id);

  it('sorts newest or oldest first', () => {
    expect(ids(applyInboxFilters(list, base))).toEqual(['new', 'mid', 'old']);
    expect(ids(applyInboxFilters(list, { ...base, sort: 'oldest' }))).toEqual(['old', 'mid', 'new']);
  });

  it('filters conversations waiting for a reply', () => {
    expect(ids(applyInboxFilters(list, { ...base, status: 'awaiting_reply' }))).toEqual(['new', 'old']);
    expect(isAwaitingReply(conv('x', { last_message_sender: 'bot' }))).toBe(false);
  });

  it('filters by the last 7 or 30 days', () => {
    expect(ids(applyInboxFilters(list, { ...base, period: '7d' }))).toEqual(['new']);
    expect(ids(applyInboxFilters(list, { ...base, period: '30d' }))).toEqual(['new', 'mid']);
  });

  it('lists unread oldest first', () => {
    expect(ids(applyInboxFilters(list, { ...base, status: 'unread', sort: 'oldest' }))).toEqual(['old', 'new']);
  });

  it('keeps the status filters', () => {
    expect(ids(applyInboxFilters(list, { ...base, status: 'closed' }))).toEqual(['old']);
  });

  it('does not mutate the input', () => {
    const copy = [...list];
    applyInboxFilters(list, { ...base, sort: 'oldest' });
    expect(list).toEqual(copy);
  });
});
