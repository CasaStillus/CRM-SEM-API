import { beforeEach, describe, expect, it, vi } from 'vitest';

// Only the message insert is under test here. Everything that fans out
// after it is faked, and the participants are handed in pre-resolved.
vi.mock('../../webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn() }));
vi.mock('../../flows/engine', () => ({
  dispatchInboundToFlows: vi.fn(async () => ({ consumed: false })),
}));
vi.mock('../../automations/engine', () => ({
  runAutomationsForTrigger: vi.fn(async () => undefined),
}));
vi.mock('../../ai/auto-reply', () => ({
  dispatchInboundToAiReply: vi.fn(async () => undefined),
}));
vi.mock('../../conversations/reopen', () => ({
  reopenClosedConversation: vi.fn(async () => undefined),
}));

import { processInboundMessage } from './process-inbound-message';
import type { NormalizedAdReferral, NormalizedInboundMessage } from './types';

interface State {
  upserts: Record<string, unknown>[];
  /** Error to return for the first upsert that carries `ad_referral`. */
  adColumnError: { code: string; message: string } | null;
  uploads: string[];
}

function fakeDb(state: State) {
  const messagesBuilder = () => {
    const builder: Record<string, unknown> = {
      select: (_cols: string, opts?: { head?: boolean }) => {
        if (opts?.head) {
          const countChain: Record<string, unknown> = {
            eq: () => countChain,
            then: (resolve: (v: unknown) => void) =>
              resolve({ count: 0, error: null }),
          };
          return countChain;
        }
        return builder;
      },
      upsert: (row: Record<string, unknown>) => ({
        select: async () => {
          state.upserts.push({ ...row });
          if ('ad_referral' in row && state.adColumnError) {
            return { data: null, error: state.adColumnError };
          }
          return { data: [{ id: `msg-${state.upserts.length}` }], error: null };
        },
      }),
    };
    return builder;
  };

  return {
    from(table: string) {
      if (table === 'messages') return messagesBuilder();
      if (table === 'broadcast_recipients' || table === 'conversations') {
        const chain: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'in', 'order', 'update']) {
          chain[m] = () => chain;
        }
        chain.limit = async () => ({ data: [], error: null });
        chain.then = (resolve: (v: unknown) => void) =>
          resolve({ data: null, error: null });
        return chain;
      }
      throw new Error(`unexpected table: ${table}`);
    },
    rpc: async () => ({ error: null }),
    storage: {
      from: () => ({
        upload: async (path: string) => {
          state.uploads.push(path);
          return { error: null };
        },
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://storage.test/${path}` },
        }),
      }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const AD: NormalizedAdReferral = {
  source: 'uazapi_external_ad_reply',
  sourceType: 'ad',
  sourceId: '120212345678900123',
  sourceUrl: 'https://fb.me/1abcDEF',
  title: 'Sofás sob medida',
  body: 'Frete grátis',
  mediaType: 'image',
  thumbnailUrl: null,
  mediaUrl: null,
  thumbnailBase64: '/9j/'.padEnd(400, 'A') + '==',
  ctwaClid: 'clid',
  raw: { externalAdReply: { title: 'Sofás sob medida' } },
};

function event(adReferral?: NormalizedAdReferral): NormalizedInboundMessage {
  return {
    kind: 'message',
    provider: 'uazapi',
    externalMessageId: '3EB0AD1234',
    occurredAt: '2026-09-29T12:00:00.000Z',
    fromMe: false,
    isGroup: false,
    sender: {
      phone: '5511988887777',
      externalId: '5511988887777@s.whatsapp.net',
      externalIdKind: 'jid',
      parentExternalId: null,
      profileName: 'Maria',
      displayName: 'Maria',
      username: null,
    },
    chat: {
      externalId: '5511988887777@s.whatsapp.net',
      phone: '5511988887777',
      isGroup: false,
      name: null,
    },
    content: { type: 'text', text: 'Tenho interesse' },
    replyToExternalId: null,
    ...(adReferral ? { adReferral } : {}),
  };
}

async function run(state: State, ev: NormalizedInboundMessage) {
  await processInboundMessage({
    db: fakeDb(state),
    event: ev,
    accountId: 'acc-1',
    configOwnerUserId: 'user-1',
    resolveMedia: async () => ({ url: null, mimeType: null }),
    participants: {
      contact: { id: 'contact-1' },
      contactWasCreated: false,
      conversation: { id: 'conv-1', status: 'open' },
      conversationWasCreated: false,
    },
  });
}

describe('processInboundMessage — ad referral', () => {
  let state: State;

  beforeEach(() => {
    state = { upserts: [], adColumnError: null, uploads: [] };
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('stores the ad card with a mirrored thumbnail', async () => {
    await run(state, event(AD));

    expect(state.upserts).toHaveLength(1);
    const stored = state.upserts[0].ad_referral as Record<string, unknown>;
    expect(stored).toMatchObject({
      source: 'uazapi_external_ad_reply',
      title: 'Sofás sob medida',
      source_url: 'https://fb.me/1abcDEF',
    });
    expect(stored.thumbnail_url).toMatch(/^https:\/\/storage\.test\//);
    expect(state.uploads).toHaveLength(1);
  });

  it('does not add the column to ordinary messages', async () => {
    await run(state, event());
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0]).not.toHaveProperty('ad_referral');
  });

  it('keeps the lead when migration 051 has not been applied', async () => {
    state.adColumnError = {
      code: 'PGRST204',
      message:
        "Could not find the 'ad_referral' column of 'messages' in the schema cache",
    };

    await run(state, event(AD));

    expect(state.upserts).toHaveLength(2);
    expect(state.upserts[1]).not.toHaveProperty('ad_referral');
    expect(state.upserts[1]).toMatchObject({
      content_text: 'Tenho interesse',
      message_id: '3EB0AD1234',
    });
  });
});
