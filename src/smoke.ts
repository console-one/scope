// ─────────────────────────────────────────────────────────────────────────
// Smoke: patches are multi-walk. Every example exercises that.
//
//   (A) `b = { a: 10, b: 20 }` — one patch, two walks (b.a and b.b).
//       The kernel processes both walks; constraints anchored at each
//       fire independently; later walks see earlier walks' mounted
//       facts (so cross-walk dependencies inside one patch work).
//
//   (B) `b = { a: 10, b: 20 }` then `<< [b<<-50, v<<500]` — second
//       patch is also multi-walk (a delta on b.b and a delta on v).
//
//   (C) head/where/body sessions.ready — the rule fires for whatever
//       user/kind binding the trie matches; mounts a body fact.
//
//   (D) escalation — no resolver registered; the unresolved hoist
//       carries the exact shape that needs filling.
// ─────────────────────────────────────────────────────────────────────────

import { Kernel } from './kernel.js';
import { Constraint, EmittedConstraint } from './constraint.js';
import { EvaluatorInput, EmitterInput } from './resolver.js';
import {
  Validity,
  Patch,
  StrictPolicy,
  PermissivePolicy,
  literal,
  wildcard,
  bind,
  REFPATH,
  SCOPE,
  IDENTITY,
} from './types.js';

const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
};

const validitiesByName = (matched: Array<{ constraint: Constraint; validity: Validity }>) =>
  Object.fromEntries(matched.map((m) => [m.constraint.id, m.validity]));

// ═══════════════════════════════════════════════════════════════════════
//  Example A: multi-walk patch with type checks
//
//  Source:    b = { a: 10, b: 20 }
//  Patch:     context = { _scope: 'root', _identity: 'alice' }
//             walks   = [{ _refpath: 'b.a', value: 10 },
//                        { _refpath: 'b.b', value: 20 }]
// ═══════════════════════════════════════════════════════════════════════

const k = new Kernel();

const forwardedToG: Array<{ source: string; columns: Record<string, unknown> }> = [];

k.registerResolver<EvaluatorInput, Validity>({
  shape: 'check.type',
  fn: (input) => {
    const expected = input.meta.expected as string;
    const v = input.patch.value;
    if (expected === 'number' && typeof v === 'number') return 'met';
    if (expected === 'string' && typeof v === 'string') return 'met';
    return 'unmet';
  },
});

k.registerResolver<EvaluatorInput, Validity>({
  shape: 'check.identity-equals',
  fn: (input) => {
    const required = input.meta.requiredIdentity as string;
    return input.patch[IDENTITY] === required ? 'met' : 'unmet';
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
    forwardedToG.push({ source, columns: input.patch });
    const derivedAnchor = input.meta.derivedAnchor as Constraint['anchor'] | undefined;
    if (!derivedAnchor) return [];
    return [
      {
        destination: 'hoist',
        constraint: {
          id: `derived:from-${source}:c${input.patch._commit}:w${input.walkIndex}`,
          anchor: derivedAnchor,
          policy: PermissivePolicy,
          evalShape: 'always.met',
          meta: { kind: 'derived', from: source },
        },
      },
    ];
  },
});

k.registerResolver<EvaluatorInput, Validity>({
  shape: 'always.met',
  fn: () => 'met',
});

// Mount: type check for both b.a (number) and b.b (number).
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
  inputs: [
    {
      pattern: { [SCOPE]: literal('root'), [REFPATH]: literal('b.a') },
      as: 'upstream',
      where: (cand) => cand.id === 'type:b.a:number',
    },
  ],
  meta: {
    inputName: 'upstream',
    source: 'b.a',
    derivedAnchor: { [SCOPE]: literal('root'), [REFPATH]: literal('g') },
  },
});

console.log('=== Example A: b = { a: 10, b: 20 } as one patch, two walks ===\n');

const rA = k.applyPatch({
  context: { [SCOPE]: 'root', [IDENTITY]: 'alice' },
  walks: [
    { [REFPATH]: 'b.a', value: 10 },
    { [REFPATH]: 'b.b', value: 20 },
  ],
});

console.log('  patch had', rA.walks.length, 'walks');
for (const w of rA.walks) {
  console.log(`  walk ${w.walkIndex} (${w.walkColumns[REFPATH]}):`);
  console.log('    matched:', validitiesByName(w.matched));
  console.log('    hoist:', w.hoist.map((e) => e.constraint.id));
}
console.log('  preempted:', rA.preempted, rA.preemptedBy ?? '');
console.log('  forwarded:', forwardedToG);

assert(rA.walks.length === 2, 'A: two walks');
assert(rA.walks[0].matched.find((m) => m.constraint.id === 'type:b.a:number')?.validity === 'met', 'A: walk0 type met');
assert(rA.walks[1].matched.find((m) => m.constraint.id === 'type:b.b:number')?.validity === 'met', 'A: walk1 type met');
assert(forwardedToG.some((f) => f.source === 'b.a' && f.columns.value === 10), 'A: walk0 forwards b.a');
assert(rA.totalHoist.some((e) => e.constraint.id.startsWith('derived:from-b.a:')), 'A: derived hoist');
assert(!rA.preempted, 'A: not preempted');

console.log('\nA: passed\n');

// ═══════════════════════════════════════════════════════════════════════
//  Example B: a multi-walk patch where one walk preempts halts the rest
//
//  Patch: alice tries to write { c = "new", b.b = 7 }. Access on c
//  fails → walk 0 preempts → walk 1 (b.b = 7) is never processed.
// ═══════════════════════════════════════════════════════════════════════

console.log('=== Example B: preempting walk halts subsequent walks ===\n');

const beforeB = forwardedToG.length;

const rB = k.applyPatch({
  context: { [SCOPE]: 'root', [IDENTITY]: 'alice' },
  walks: [
    { [REFPATH]: 'c', value: 'new' },        // will fail access
    { [REFPATH]: 'b.b', value: 7 },           // would have succeeded
  ],
});

console.log('  patch processed', rB.walks.length, 'walk(s)');
for (const w of rB.walks) {
  console.log(`  walk ${w.walkIndex} (${w.walkColumns[REFPATH]}):`);
  console.log('    matched:', validitiesByName(w.matched));
  console.log('    preempted:', w.preempted, w.preemptedBy ?? '');
}
console.log('  patch preempted:', rB.preempted, rB.preemptedBy ?? '');
console.log('  forwarded since:', forwardedToG.slice(beforeB));

assert(rB.walks.length === 1, 'B: only first walk ran (preempted)');
assert(rB.preempted && rB.preemptedBy === 'access:c:admin', 'B: preempted by access');
assert(forwardedToG.slice(beforeB).length === 0, 'B: nothing forwarded');

console.log('\nB: passed\n');

// ═══════════════════════════════════════════════════════════════════════
//  Example C: head/where/body sessions.ready (multi-walk patches that
//  set up the conditions, then the rule fires)
// ═══════════════════════════════════════════════════════════════════════

console.log('=== Example C: head/where/body sessions.ready ===\n');

const k2 = new Kernel();
const statusReadyMounts: Array<{ user: unknown }> = [];

k2.registerResolver<EvaluatorInput, Validity>({
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

k2.registerResolver<EmitterInput, EmittedConstraint[]>({
  shape: 'rule.mount-body',
  fn: (input) => {
    if (input.validity !== 'met') return [];
    const idTemplate = input.meta.bodyIdTemplate as string;
    const bindings = input.bindings;
    const sub = (s: string) => s.replace(/\{(\w+)\}/g, (_, key) => String(bindings[key] ?? `?${key}`));
    const id = sub(idTemplate);

    const bodyTemplate = input.meta.bodyTemplate as Record<string, unknown>;
    const anchor: Constraint['anchor'] = {};
    for (const [col, val] of Object.entries(bodyTemplate)) {
      if (typeof val === 'string' && val.startsWith('$')) {
        anchor[col] = { kind: 'literal', value: bindings[val.slice(1)] };
      } else {
        anchor[col] = { kind: 'literal', value: val };
      }
    }

    statusReadyMounts.push({ user: bindings.user });
    return [
      {
        destination: 'mount',
        constraint: {
          id,
          anchor,
          policy: PermissivePolicy,
          evalShape: 'always.met',
          meta: { kind: 'body-fact', bindings: { ...bindings } },
        },
      },
    ];
  },
});

k2.registerResolver<EvaluatorInput, Validity>({ shape: 'always.met', fn: () => 'met' });

k2.mount({
  id: 'rule:sessions.ready',
  anchor: { [SCOPE]: literal('sessions'), user: bind('user'), kind: wildcard() },
  policy: PermissivePolicy,
  evalShape: 'rule.all-inputs-exist',
  emitShape: 'rule.mount-body',
  inputs: [
    {
      pattern: { [SCOPE]: literal('sessions'), user: bind('user'), kind: literal('heartbeat') },
      as: 'heartbeat',
      where: (c) => c.resolved !== undefined,
    },
    {
      pattern: { [SCOPE]: literal('sessions'), user: bind('user'), kind: literal('env') },
      as: 'env',
      where: (c) => c.resolved !== undefined,
    },
  ],
  meta: {
    requiredInputs: ['heartbeat', 'env'],
    bodyIdTemplate: 'body:sessions.{user}.status',
    bodyTemplate: { [SCOPE]: 'sessions', user: '$user', kind: 'status', value: 'ready' },
  },
});

// One patch with two walks: alice's heartbeat AND alice's env land
// together. The rule fires for user=alice on either walk; on the second
// walk it sees the first walk's mounted fact and resolves 'met'.
console.log('--- one patch: { sessions.alice.heartbeat, sessions.alice.env } ---');
const rC = k2.applyPatch({
  context: { [SCOPE]: 'sessions', user: 'alice' },
  walks: [
    { kind: 'heartbeat', ts: 1000 },
    { kind: 'env', region: 'us-west' },
  ],
});

for (const w of rC.walks) {
  console.log(`  walk ${w.walkIndex} (${w.walkColumns.kind}):`);
  console.log('    matched:', w.matched.map((m) => `[user=${m.bindings.user}]→${m.validity}`));
  console.log('    body emitted:', w.mount.map((e) => e.constraint.id));
}

// The first walk is heartbeat; env doesn't exist yet → undetermined.
// The second walk is env; by the time it processes, heartbeat is mounted
// as a fact (kernel persists between walks) → both inputs exist → met
// → emits body fact.
const w0Match = rC.walks[0].matched.find((m) => m.constraint.id === 'rule:sessions.ready');
const w1Match = rC.walks[1].matched.find((m) => m.constraint.id === 'rule:sessions.ready');
assert(w0Match?.validity === 'undetermined', 'C: walk0 undetermined (env not yet mounted)');
assert(w1Match?.validity === 'met', 'C: walk1 met (heartbeat mounted by walk0)');
assert(rC.totalMount.some((e) => e.constraint.id === 'body:sessions.alice.status'), 'C: body fact emitted');

console.log('\nC: passed\n');

// ═══════════════════════════════════════════════════════════════════════
//  Example D: escalation — no resolver registered.
// ═══════════════════════════════════════════════════════════════════════

console.log('=== Example D: no resolver = escalation ===\n');

const k3 = new Kernel();

k3.mount({
  id: 'lonely',
  anchor: { [SCOPE]: literal('elsewhere'), [REFPATH]: literal('thing') },
  policy: { met: 'continue', unmet: 'continue', undetermined: 'hoist' },
  evalShape: 'check.type',
  meta: { expected: 'number' },
});

const rD = k3.applyPatch({
  context: { [SCOPE]: 'elsewhere' },
  walks: [{ [REFPATH]: 'thing', value: 42 }],
});

console.log('  walk 0 matched:', rD.walks[0].matched.map((m) => `${m.constraint.id}→${m.validity}`));
console.log('  unresolved hoists:', rD.totalUnresolvedHoists);
console.log('  hoisted:', rD.totalHoist.map((e) => e.constraint.id));

assert(rD.walks[0].matched[0]?.validity === 'undetermined', 'D: undetermined');
assert(rD.totalUnresolvedHoists.length === 1, 'D: one unresolved hoist');
assert(rD.totalUnresolvedHoists[0].shape === 'check.type', 'D: shape is check.type');
assert(rD.totalHoist.length === 1, 'D: hoisted upward');

console.log('\nD: passed');
console.log('\n— escalation shape: check.type at elsewhere/thing —');
