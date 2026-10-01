import { describe, expect, it } from 'vitest';

import {
  dealHasValue,
  isDealValueRequiredError,
  stageRequiresValue,
} from './deal-value-rule';

describe('stageRequiresValue', () => {
  it.each(['Negociação', 'negociacao', 'Em negociação', 'NEGOCIAÇÃO final'])(
    'requires a value in "%s"',
    (name) => expect(stageRequiresValue(name)).toBe(true)
  );

  it.each(['Novo contato', 'Qualificado', 'Proposta enviada', 'Ganho', '', null])(
    'does not require a value in "%s"',
    (name) => expect(stageRequiresValue(name)).toBe(false)
  );
});

describe('dealHasValue', () => {
  it.each([[1], [0.01], ['150'], ['99.90']])('accepts %s', (v) =>
    expect(dealHasValue(v)).toBe(true)
  );
  it.each([[0], ['0'], [-5], [''], ['abc'], [null], [undefined], [NaN]])(
    'rejects %s',
    (v) => expect(dealHasValue(v)).toBe(false)
  );
});

describe('isDealValueRequiredError', () => {
  it('recognizes the trigger error from migration 052', () => {
    expect(
      isDealValueRequiredError({ code: '23514', message: 'deal_value_required' })
    ).toBe(true);
    expect(isDealValueRequiredError({ message: 'permission denied' })).toBe(false);
    expect(isDealValueRequiredError(null)).toBe(false);
  });
});
