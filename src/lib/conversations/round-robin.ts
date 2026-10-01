/**
 * Lead round robin: hands a new lead's conversation to the next
 * available seller.
 *
 * The choice itself lives in the database
 * (`assign_next_round_robin_agent`, migration 053), where a row lock
 * makes two leads arriving together go to two different people. This
 * wrapper only calls it and never throws: a lead that could not be
 * distributed stays unassigned, which means the admin sees it and can
 * hand it over by hand.
 */

interface RpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;
}

/** True when the function does not exist yet: migration 053 not applied. */
function isMissingFunction(error: { message?: string; code?: string }): boolean {
  return (
    error.code === 'PGRST202' ||
    error.code === '42883' ||
    /assign_next_round_robin_agent/.test(error.message ?? '')
  );
}

/**
 * Returns the user id the conversation went to, or null when it was not
 * distributed (already had an owner, is a group, nobody available, or
 * the migration is missing).
 */
export async function assignByRoundRobin(
  db: RpcClient,
  conversationId: string
): Promise<string | null> {
  try {
    const { data, error } = await db.rpc('assign_next_round_robin_agent', {
      p_conversation_id: conversationId,
    });
    if (error) {
      if (isMissingFunction(error)) {
        console.warn(
          '[round-robin] assign_next_round_robin_agent is missing — run migration 053. Lead left unassigned.'
        );
      } else {
        console.error('[round-robin] assignment failed:', error.message);
      }
      return null;
    }
    return typeof data === 'string' && data.length > 0 ? data : null;
  } catch (error) {
    console.error(
      '[round-robin] assignment threw:',
      error instanceof Error ? error.message : error
    );
    return null;
  }
}
