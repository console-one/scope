// ─────────────────────────────────────────────────────────────────────────
// Rule with head/where/body: a constraint with bind() in its anchor
// matches multiple users via the trie; when its inputs are all 'met',
// its emitShape mounts a body fact.
// ─────────────────────────────────────────────────────────────────────────

import {
  Kernel,
  type Constraint,
  type EmittedConstraint,
  type EvaluatorInput,
  type EmitterInput,
  Validity,
  PermissivePolicy,
  literal,
  bind,
  wildcard,
  SCOPE,
} from '../index.js';

function buildSessionKernel() {
  const k = new Kernel();

  k.registerResolver<EvaluatorInput, Validity>({
    shape: 'rule.all-inputs-exist',
    fn: (input) => {
      const required = input.meta.requiredInputs as string[];
      for (const name of required) {
        const matches = input.inputMatches.get(name) ?? [];
        if (matches.length === 0 || !matches.some((c) => c.resolved)) return 'undetermined';
      }
      return 'met';
    },
  });

  k.registerResolver<EmitterInput, EmittedConstraint[]>({
    shape: 'rule.mount-body',
    fn: (input) => {
      if (input.validity !== 'met') return [];
      const idTemplate = input.meta.bodyIdTemplate as string;
      const sub = (s: string) =>
        s.replace(/\{(\w+)\}/g, (_, key) => String(input.bindings[key] ?? `?${key}`));
      const id = sub(idTemplate);
      const bodyTemplate = input.meta.bodyTemplate as Record<string, unknown>;
      const anchor: Constraint['anchor'] = {};
      for (const [col, val] of Object.entries(bodyTemplate)) {
        if (typeof val === 'string' && val.startsWith('$')) {
          anchor[col] = { kind: 'literal', value: input.bindings[val.slice(1)] };
        } else {
          anchor[col] = { kind: 'literal', value: val };
        }
      }
      return [{
        destination: 'mount',
        constraint: {
          id,
          anchor,
          policy: PermissivePolicy,
          evalShape: 'always.met',
          meta: { kind: 'body-fact', bindings: { ...input.bindings } },
        },
      }];
    },
  });

  k.registerResolver<EvaluatorInput, Validity>({ shape: 'always.met', fn: () => 'met' });

  k.mount({
    id: 'rule:sessions.ready',
    anchor: { [SCOPE]: literal('sessions'), user: bind('user'), kind: wildcard() },
    policy: PermissivePolicy,
    evalShape: 'rule.all-inputs-exist',
    emitShape: 'rule.mount-body',
    inputs: [
      {
        pattern: { [SCOPE]: literal('sessions'), user: bind('user'), kind: literal('heartbeat') },
        as: 'heartbeat',
        where: (c: any) => c.resolved !== undefined,
      },
      {
        pattern: { [SCOPE]: literal('sessions'), user: bind('user'), kind: literal('env') },
        as: 'env',
        where: (c: any) => c.resolved !== undefined,
      },
    ],
    meta: {
      requiredInputs: ['heartbeat', 'env'],
      bodyIdTemplate: 'body:sessions.{user}.status',
      bodyTemplate: { [SCOPE]: 'sessions', user: '$user', kind: 'status', value: 'ready' },
    },
  });
  return k;
}

export default async (test: (name: string, body: (validator: any) => any) => any) => {
  await test('rule fires on the second walk after first walk supplies the missing input', async (validator: any) => {
    const k = buildSessionKernel();
    const r = k.applyPatch({
      context: { [SCOPE]: 'sessions', user: 'alice' },
      walks: [
        { kind: 'heartbeat', ts: 1000 },
        { kind: 'env', region: 'us-west' },
      ],
    });
    const w0 = r.walks[0].matched.find((m: any) => m.constraint.id === 'rule:sessions.ready');
    const w1 = r.walks[1].matched.find((m: any) => m.constraint.id === 'rule:sessions.ready');
    const bodyMounted = r.totalMount.some(
      (e: any) => e.constraint.id === 'body:sessions.alice.status',
    );
    return validator.expect({
      w0Validity: w0?.validity,
      w1Validity: w1?.validity,
      bodyMounted,
    }).toLookLike({
      w0Validity: 'undetermined',
      w1Validity: 'met',
      bodyMounted: true,
    });
  });
};
