// ─────────────────────────────────────────────────────────────────────────
// Escalation: with no resolver registered for a constraint's evalShape,
// the kernel returns 'undetermined' and the constraint hoists upward,
// carrying its shape and anchor for an outer scope to satisfy.
// ─────────────────────────────────────────────────────────────────────────

import {
  Kernel,
  literal,
  REFPATH,
  SCOPE,
} from '../index.js';

export default async (test: (name: string, body: (validator: any) => any) => any) => {
  await test('no resolver → undetermined → hoisted with shape preserved', async (validator: any) => {
    const k = new Kernel();
    k.mount({
      id: 'lonely',
      anchor: { [SCOPE]: literal('elsewhere'), [REFPATH]: literal('thing') },
      policy: { met: 'continue', unmet: 'continue', undetermined: 'hoist' },
      evalShape: 'check.type',
      meta: { expected: 'number' },
    });
    const r = k.applyPatch({
      context: { [SCOPE]: 'elsewhere' },
      walks: [{ [REFPATH]: 'thing', value: 42 }],
    });
    return validator.expect({
      validity: r.walks[0].matched[0]?.validity,
      unresolvedCount: r.totalUnresolvedHoists.length,
      shape: r.totalUnresolvedHoists[0]?.shape,
      hoistedCount: r.totalHoist.length,
    }).toLookLike({
      validity: 'undetermined',
      unresolvedCount: 1,
      shape: 'check.type',
      hoistedCount: 1,
    });
  });
};
