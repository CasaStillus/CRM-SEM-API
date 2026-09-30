import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { dispatchInboundToFlows } from '../../flows/engine';
import { processInboundMessage } from './process-inbound-message';
import type { NormalizedInboundMessage } from './types';
import { normalizeUazapiWebhook } from './uazapi-normalizer';

/** WhatsApp's reaction message as UAZAPI forwards it. */
const REACTION = {
  id: '5516994306261:3EB0REACT01',
  messageid: '3EB0REACT01',
  chatid: '5511988887777@s.whatsapp.net',
  sender: '5511988887777@s.whatsapp.net',
  sender_pn: '5511988887777@s.whatsapp.net',
  senderName: 'Maria',
  fromMe: false,
  isGroup: false,
  wasSentByApi: false,
  messageType: 'ReactionMessage',
  messageTimestamp: 1790730000000,
  text: '❤️',
  content: {
    text: '❤️',
    key: {
      ID: '3EB0TARGET99',
      fromMe: true,
      remoteJID: '5511988887777@s.whatsapp.net',
    },
    senderTimestampMS: 1790730000000,
  },
};

function delivery(message: Record<string, unknown>) {
  return { EventType: 'messages', instanceName: 'wacrm-test', message };
}

function firstEvent(message: Record<string, unknown>) {
  const result = normalizeUazapiWebhook(delivery(message));
  if (result.outcome !== 'event') {
    throw new Error(`expected an event, got ${JSON.stringify(result)}`);
  }
  return result.events[0] as NormalizedInboundMessage;
}

describe('normalizeUazapiWebhook — reactions', () => {
  it('reads the emoji and the reacted-to message', () => {
    expect(firstEvent(REACTION).reaction).toEqual({
      emoji: '❤️',
      targetExternalId: '3EB0TARGET99',
    });
  });

  it('reads the target from `reaction` and strips the owner prefix', () => {
    const event = firstEvent({
      ...REACTION,
      content: '👍',
      text: '👍',
      reaction: '5516994306261:3EB0OTHER77',
    });
    expect(event.reaction).toEqual({
      emoji: '👍',
      targetExternalId: '3EB0OTHER77',
    });
  });

  it('treats an empty emoji as a removal', () => {
    const event = firstEvent({
      ...REACTION,
      text: '',
      content: { text: '', key: { ID: '3EB0TARGET99' } },
    });
    expect(event.reaction).toEqual({
      emoji: '',
      targetExternalId: '3EB0TARGET99',
    });
  });

  it('quarantines a reaction that names no message', () => {
    const result = normalizeUazapiWebhook(
      delivery({ ...REACTION, content: { text: '👍' } })
    );
    expect(result).toMatchObject({
      outcome: 'quarantine',
      reasonCode: 'missing_message_id',
    });
  });

  it('leaves ordinary messages without a reaction', () => {
    const event = firstEvent({
      ...REACTION,
      messageType: 'Conversation',
      content: 'oi',
      text: 'oi',
    });
    expect(event.reaction).toBeUndefined();
  });
});

interface State {
  upserts: Record<string, unknown>[];
  deletes: Record<string, unknown>[];
  messageInserts: number;
  targetFound: boolean;
}

function fakeDb(state: State) {
  return {
    from(table: string) {
      if (table === 'messages') {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({
            data: state.targetFound ? { id: 'internal-target' } : null,
            error: null,
          }),
          upsert: () => {
            state.messageInserts += 1;
            return { select: async () => ({ data: [{ id: 'x' }], error: null }) };
          },
        };
        return chain;
      }
      if (table === 'message_reactions') {
        return {
          upsert: async (row: Record<string, unknown>) => {
            state.upserts.push(row);
            return { error: null };
          },
          delete: () => {
            const filters: Record<string, unknown> = {};
            const chain: Record<string, unknown> = {
              eq: (col: string, value: unknown) => {
                filters[col] = value;
                if (Object.keys(filters).length === 3) {
                  state.deletes.push(filters);
                  return Promise.resolve({ error: null });
                }
                return chain;
              },
            };
            return chain;
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function run(state: State, event: NormalizedInboundMessage) {
  await processInboundMessage({
    db: fakeDb(state),
    event,
    accountId: 'acc-1',
    configOwnerUserId: 'owner-user',
    resolveMedia: async () => ({ url: null, mimeType: null }),
    participants: {
      contact: { id: 'contact-1' },
      contactWasCreated: false,
      conversation: { id: 'conv-1' },
      conversationWasCreated: false,
    },
  });
}

describe('processInboundMessage — reactions', () => {
  let state: State;

  beforeEach(() => {
    state = { upserts: [], deletes: [], messageInserts: 0, targetFound: true };
    vi.mocked(dispatchInboundToFlows).mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('stores a customer reaction and nothing else', async () => {
    await run(state, firstEvent(REACTION));

    expect(state.upserts).toEqual([
      {
        message_id: 'internal-target',
        conversation_id: 'conv-1',
        actor_type: 'customer',
        actor_id: 'contact-1',
        emoji: '❤️',
      },
    ]);
    expect(state.messageInserts).toBe(0);
    expect(dispatchInboundToFlows).not.toHaveBeenCalled();
  });

  it('files a reaction made on the linked phone under the owner', async () => {
    await run(state, firstEvent({ ...REACTION, fromMe: true }));
    expect(state.upserts[0]).toMatchObject({
      actor_type: 'agent',
      actor_id: 'owner-user',
    });
  });

  it('removes the reaction on an empty emoji', async () => {
    await run(
      state,
      firstEvent({
        ...REACTION,
        text: '',
        content: { text: '', key: { ID: '3EB0TARGET99' } },
      })
    );
    expect(state.deletes).toEqual([
      {
        message_id: 'internal-target',
        actor_type: 'customer',
        actor_id: 'contact-1',
      },
    ]);
    expect(state.upserts).toHaveLength(0);
  });

  it('skips a reaction to a message the CRM never stored', async () => {
    state.targetFound = false;
    await run(state, firstEvent(REACTION));
    expect(state.upserts).toHaveLength(0);
    expect(state.messageInserts).toBe(0);
  });
});
