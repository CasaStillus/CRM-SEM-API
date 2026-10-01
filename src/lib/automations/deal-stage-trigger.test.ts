import { describe, expect, it, vi } from 'vitest'

vi.mock('./admin-client', () => ({ supabaseAdmin: () => ({}) }))
vi.mock('./meta-send', () => ({}))

import type { Automation } from '@/types'

import { triggerMatches } from './engine'
import { validateTriggerForActivation } from './validate'

const automation = (cfg: Record<string, unknown>) =>
  ({
    id: 'a',
    trigger_type: 'deal_stage_changed',
    trigger_config: cfg,
  }) as unknown as Automation

describe('deal_stage_changed trigger', () => {
  const cfg = { pipeline_id: 'p1', stage_id: 'negociacao' }

  it('fires when the deal enters the chosen stage', () => {
    expect(
      triggerMatches(automation(cfg), { stage_id: 'negociacao', from_stage_id: 'novo' }),
    ).toBe(true)
  })

  it('does not fire for another stage', () => {
    expect(
      triggerMatches(automation(cfg), { stage_id: 'ganho', from_stage_id: 'negociacao' }),
    ).toBe(false)
  })

  it('does not fire when the deal stayed in the stage', () => {
    expect(
      triggerMatches(automation(cfg), { stage_id: 'negociacao', from_stage_id: 'negociacao' }),
    ).toBe(false)
  })

  it('does not fire without a stage or without configuration', () => {
    expect(triggerMatches(automation(cfg), {})).toBe(false)
    expect(triggerMatches(automation({}), { stage_id: 'negociacao' })).toBe(false)
  })

  it('requires funnel and stage before activation', () => {
    expect(validateTriggerForActivation('deal_stage_changed', {}).map((i) => i.path)).toEqual([
      'trigger.pipeline_id',
      'trigger.stage_id',
    ])
    expect(validateTriggerForActivation('deal_stage_changed', cfg)).toEqual([])
  })
})
