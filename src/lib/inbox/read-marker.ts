/**
 * Records that the person logged in has seen a conversation up to now
 * (migration 055). Feeds that person's own unread count, which is what
 * an admin following a seller's conversation sees. Best effort: a
 * failure, or a database without migration 055, only means the count
 * is not cleared.
 */

interface RpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>
  ): PromiseLike<{ error: { message?: string; code?: string } | null }>;
}

export async function markConversationRead(
  db: RpcClient,
  conversationId: string
): Promise<void> {
  try {
    const { error } = await db.rpc('mark_conversation_read', {
      p_conversation_id: conversationId,
    });
    if (error && error.code !== 'PGRST202' && error.code !== '42883') {
      console.warn('[inbox] could not record read:', error.message);
    }
  } catch {
    // Network blip: the next open records it.
  }
}
