/**
 * Tells the server a deal moved stage so `deal_stage_changed`
 * automations run. Fire-and-forget: the move is already saved, and an
 * automation that could not start must not undo it or block the board.
 */
export function notifyDealStageChanged(
  dealId: string,
  fromStageId: string | null,
): void {
  try {
    void fetch('/api/automations/deal-stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deal_id: dealId, from_stage_id: fromStageId }),
      keepalive: true,
    }).catch(() => {})
  } catch {
    // No fetch (tests, very old browser): nothing to do.
  }
}
