import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { runAutomationsForTrigger } from '@/lib/automations/engine'

/**
 * Fires `deal_stage_changed` automations after a deal moved stage
 * (Kanban drag or the deal form).
 *
 * The caller only says which deal moved and where it came from. The
 * deal itself is read with the caller's own session, so RLS decides
 * whether they may see it, and its current stage, contact and account
 * come from the database, not from the request.
 */
export async function POST(request: Request) {
  let ctx: Awaited<ReturnType<typeof requireRole>>
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = (await request.json().catch(() => null)) as {
    deal_id?: unknown
    from_stage_id?: unknown
  } | null
  const dealId = typeof body?.deal_id === 'string' ? body.deal_id : null
  const fromStageId =
    typeof body?.from_stage_id === 'string' ? body.from_stage_id : null
  if (!dealId) {
    return NextResponse.json({ error: 'deal_id é obrigatório' }, { status: 400 })
  }

  const { data: deal, error } = await ctx.supabase
    .from('deals')
    .select('id, account_id, pipeline_id, stage_id, contact_id, conversation_id')
    .eq('id', dealId)
    .maybeSingle()

  if (error) {
    console.error('[deal-stage] deal lookup failed:', error.message)
    return NextResponse.json({ error: 'Falha ao ler o negócio' }, { status: 500 })
  }
  // Not visible to the caller (or already handed to someone else): the
  // move was theirs to make, the automation is not theirs to fire.
  if (!deal || deal.account_id !== ctx.accountId) {
    return NextResponse.json({ ok: true, fired: false })
  }
  if (deal.stage_id === fromStageId) {
    return NextResponse.json({ ok: true, fired: false })
  }

  await runAutomationsForTrigger({
    accountId: ctx.accountId,
    triggerType: 'deal_stage_changed',
    contactId: deal.contact_id ?? null,
    context: {
      deal_id: deal.id,
      stage_id: deal.stage_id,
      from_stage_id: fromStageId,
      pipeline_id: deal.pipeline_id,
      ...(deal.conversation_id ? { conversation_id: deal.conversation_id } : {}),
    },
  })

  return NextResponse.json({ ok: true, fired: true })
}
