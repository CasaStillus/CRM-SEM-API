import { describe, expect, it, vi } from 'vitest';

vi.mock('../../webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn() }));

import { processStatusUpdate } from './process-status-update';
import type { InboundDatabase, NormalizedStatusUpdate } from './types';

function fakeDb(rpcResult: { error: { code?: string; message?: string } | null } = { error: null }) {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: () => builder,
    eq: () => builder,
    limit: () => builder,
    update: () => builder,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: (r: { data: null; error: null }) => unknown) =>
      resolve({ data: null, error: null }),
  });
  const rpc = vi.fn().mockResolvedValue(rpcResult);
  const db = { from: () => builder, rpc } as unknown as InboundDatabase;
  return { db, rpc };
}

const event = (status: NormalizedStatusUpdate['status']): NormalizedStatusUpdate => ({
  kind: 'status',
  provider: 'uazapi',
  externalMessageId: 'MSG1',
  status,
  occurredAt: '2026-10-01T12:00:00.000Z',
  failure: null,
});

describe('processStatusUpdate — read on the business phone', () => {
  it('lowers the unread count when a message is marked read', async () => {
    const { db, rpc } = fakeDb();
    await processStatusUpdate({ db, event: event('read') });
    expect(rpc).toHaveBeenCalledWith('apply_phone_read', {
      p_external_message_id: 'MSG1',
      p_provider: 'uazapi',
    });
  });

  it('ignores delivery receipts', async () => {
    const { db, rpc } = fakeDb();
    await processStatusUpdate({ db, event: event('delivered') });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('keeps going when migration 055 is missing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = fakeDb({ error: { code: 'PGRST202', message: 'missing' } });
    await expect(processStatusUpdate({ db, event: event('read') })).resolves.toBeUndefined();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
