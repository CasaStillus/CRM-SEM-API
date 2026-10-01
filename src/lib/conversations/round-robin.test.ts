import { afterEach, describe, expect, it, vi } from 'vitest';

import { assignByRoundRobin } from './round-robin';

function client(result: { data: unknown; error: { message?: string; code?: string } | null }) {
  return { rpc: vi.fn().mockResolvedValue(result) };
}

afterEach(() => vi.restoreAllMocks());

describe('assignByRoundRobin', () => {
  it('returns the user the database picked', async () => {
    const db = client({ data: 'user-1', error: null });
    await expect(assignByRoundRobin(db, 'conv-1')).resolves.toBe('user-1');
    expect(db.rpc).toHaveBeenCalledWith('assign_next_round_robin_agent', {
      p_conversation_id: 'conv-1',
    });
  });

  it('returns null when nobody was picked', async () => {
    await expect(assignByRoundRobin(client({ data: null, error: null }), 'c')).resolves.toBeNull();
    await expect(assignByRoundRobin(client({ data: '', error: null }), 'c')).resolves.toBeNull();
  });

  it('warns about the migration when the function is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = client({ data: null, error: { code: 'PGRST202', message: 'not found' } });
    await expect(assignByRoundRobin(db, 'c')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('053'));
  });

  it('logs other errors and leaves the lead unassigned', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = client({ data: null, error: { code: '500', message: 'boom' } });
    await expect(assignByRoundRobin(db, 'c')).resolves.toBeNull();
    expect(error).toHaveBeenCalled();
  });

  it('never throws when the call itself fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = { rpc: vi.fn().mockRejectedValue(new Error('network')) };
    await expect(assignByRoundRobin(db, 'c')).resolves.toBeNull();
  });
});
