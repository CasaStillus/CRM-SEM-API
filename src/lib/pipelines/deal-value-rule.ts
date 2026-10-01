/**
 * "A deal in negotiation must have a price."
 *
 * The rule follows the stage's NAME: any stage whose name contains
 * "negocia" (Negociação, Em negociação, Negociacao…) requires a value
 * above zero. Naming it is how the team already says which column is
 * the negotiation one, so there is no extra switch to forget to turn on,
 * and a new pipeline gets the rule the moment it has such a stage.
 *
 * The same rule is enforced in the database (migration 052), so a deal
 * cannot slip into negotiation without a price through the API or an
 * automation either. This file is the browser's copy, used to ask for
 * the value up front instead of failing after the drop.
 */

/** Must match `stage_requires_deal_value()` in migration 052. */
export function stageRequiresValue(stageName: string | null | undefined): boolean {
  return /negocia/i.test(stageName ?? '');
}

export function dealHasValue(value: number | string | null | undefined): boolean {
  const amount = typeof value === 'string' ? parseFloat(value) : value;
  return typeof amount === 'number' && Number.isFinite(amount) && amount > 0;
}

/** True when the database refused a deal for missing its value. */
export function isDealValueRequiredError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('deal_value_required');
}
