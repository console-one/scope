// ─────────────────────────────────────────────────────────────────────────
// A patch is multi-walk: one (context, [walks]) batch. The kernel processes
// each walk in order; later walks see earlier walks' mounted facts.
// ─────────────────────────────────────────────────────────────────────────

import {
  Kernel,
  type Constraint,
  type EmittedConstraint,
  type EvaluatorInput,
  type EmitterInput,
  Validity,
  StrictPolicy,
  PermissivePolicy,
  literal,
  REFPATH,
  SCOPE,
  IDENTITY,
} from '../index.js';

function buildKernel() {
  const forwarded: Array<{ source: string; columns: Record<string, unknown> }> = [];
  const k = new Kernel();

  k.registerResolver<EvaluatorInput, Validity>({
    shape: 'check.type',
    fn: (input) => {
      const expected = input.meta.expected as string;
      const v = (input.patch as any).value;
      if (expected === 'number' && typeof v === 'number') return 'met';
      if (expected === 'string' && typeof v === 'string') return 'met';
      return 'unmet';
    },
  });
  k.registerResolver<EvaluatorInput, Validity>({
    shape: 'check.identity-equals',
    fn: (input) => {
      const required = input.meta.requiredIdentity as string;
      return (input.patch as any)[IDENTITY] === required ? 'met' : 'unmet';
    },
  });
  k.registerResolver<EvaluatorInput, Validity>({
    shape: 'gate.requires-input-met',
    fn: (input) => {
      const inputName = input.meta.inputName as string;
      const matches = input.inputMatches.get(inputName) ?? [];
      return matches.some((c) => input.resolutions.get(c.id) === 'met') ? 'met' : 'undetermined';
    },
  });
  k.registerResolver<EmitterInput, EmittedConstraint[]>({
    shape: 'gate.forward',
    fn: (input) => {
      if (input.validity !== 'met') return [];
      const source = input.meta.source as string;
      forwarded.push({ source, columns: input.patch as any });
      const derived = input.meta.derivedAnchor as Constraint['anchor'] | undefined;
      if (!derived) return [];
      return [{
        destination: 'hoist',
        constraint: {
          id: `derived:${source}:c${(input.patch as any)._commit}:w${input.walkIndex}`,
          anchor: derived,
          policy: PermissivePolicy,
          evalShape: 'always.met',
          meta: { kind: 'derived', from: source },
        },
      }];
    },
  });
  k.registerResolver<EvaluatorInput, Validity>({ shape: 'always.met', fn: () => 'met' });

  k.mount({
    id: 'type:b.a:number',
    anchor: { [SCOPE]: literal('root'), [REFPATH]: literal('b.a') },
    policy: StrictPolicy,
    evalShape: 'check.type',
    meta: { expected: 'number' },
  });
  k.mount({
    id: 'type:b.b:number',
    anchor: { [SCOPE]: literal('root'), [REFPATH]: literal('b.b') },
    policy: StrictPolicy,
    evalShape: 'check.type',
    meta: { expected: 'number' },
  });
  k.mount({
    id: 'access:c:admin',
    anchor: { [SCOPE]: literal('root'), [REFPATH]: literal('c') },
    policy: StrictPolicy,
    evalShape: 'check.identity-equals',
    meta: { requiredIdentity: 'admin' },
  });
  k.mount({
    id: 'gate:b.a→g',
    anchor: { [SCOPE]: literal('root'), [REFPATH]: literal('b.a') },
    policy: PermissivePolicy,
    evalShape: 'gate.requires-input-met',
    emitShape: 'gate.forward',
    inputs: [{
      pattern: { [SCOPE]: literal('root'), [REFPATH]: literal('b.a') },
      as: 'upstream',
      where: (cand: any) => cand.id === 'type:b.a:number',
    }],
    meta: {
      inputName: 'upstream',
      source: 'b.a',
      derivedAnchor: { [SCOPE]: literal('root'), [REFPATH]: literal('g') },
    },
  });
  return { k, forwarded };
}

export default async (test: (name: string, body: (validator: any) => any) => any) => {
  await test('multi-walk patch processes all walks; both type checks pass', async (validator: any) => {
    const { k } = buildKernel();
    const r = k.applyPatch({
      context: { [SCOPE]: 'root', [IDENTITY]: 'alice' },
      walks: [
        { [REFPATH]: 'b.a', value: 10 },
        { [REFPATH]: 'b.b', value: 20 },
      ],
    });
    return validator.expect({
      walks: r.walks.length,
      walk0Met: r.walks[0].matched.find((m: any) => m.constraint.id === 'type:b.a:number')?.validity,
      walk1Met: r.walks[1].matched.find((m: any) => m.constraint.id === 'type:b.b:number')?.validity,
      preempted: r.preempted,
    }).toLookLike({ walks: 2, walk0Met: 'met', walk1Met: 'met', preempted: false });
  });

  await test('gate forwards when its input is met; mounts a derived hoist', async (validator: any) => {
    const { k, forwarded } = buildKernel();
    const r = k.applyPatch({
      context: { [SCOPE]: 'root', [IDENTITY]: 'alice' },
      walks: [
        { [REFPATH]: 'b.a', value: 10 },
        { [REFPATH]: 'b.b', value: 20 },
      ],
    });
    const matchedForward = forwarded.some((f) => f.source === 'b.a' && (f.columns as any).value === 10);
    const derivedHoist = r.totalHoist.some((e: any) => e.constraint.id.startsWith('derived:b.a:'));
    return validator.expect({ matchedForward, derivedHoist }).toLookLike({
      matchedForward: true, derivedHoist: true,
    });
  });

  await test('preempting walk halts subsequent walks in the same patch', async (validator: any) => {
    const { k, forwarded } = buildKernel();
    const r = k.applyPatch({
      context: { [SCOPE]: 'root', [IDENTITY]: 'alice' },
      walks: [
        { [REFPATH]: 'c', value: 'new' }, // access fails
        { [REFPATH]: 'b.b', value: 7 },    // never runs
      ],
    });
    return validator.expect({
      processed: r.walks.length,
      preempted: r.preempted,
      preemptedBy: r.preemptedBy,
      forwardedSize: forwarded.length,
    }).toLookLike({
      processed: 1,
      preempted: true,
      preemptedBy: 'access:c:admin',
      forwardedSize: 0,
    });
  });
};
