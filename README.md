# @console-one/scope

Constraint-propagation kernel over multi-dimensional anchors.

A patch is a `(context, [walks])` batch. The kernel processes each walk in
order against a trie of mounted constraints; later walks see facts mounted
by earlier walks. Each constraint resolves to a three-valued validity —
`met` / `unmet` / `undetermined` — and a per-validity policy decides
whether to `continue`, `preempt` (halt the rest of the patch), or `hoist`
(escalate the constraint to an outer scope to fill in).

The same kernel drives access control, type checking, gates, and lifecycle
— it doesn't know the difference; the difference is in which `evalShape`
a resolver is registered for.

## Install

```sh
npm install @console-one/scope
```

## Quick start

```ts
import {
  Kernel,
  literal, REFPATH, SCOPE, IDENTITY,
  StrictPolicy,
  type EvaluatorInput,
  Validity,
} from '@console-one/scope';

const k = new Kernel();

// Register a resolver for the 'check.type' shape.
k.registerResolver<EvaluatorInput, Validity>({
  shape: 'check.type',
  fn: (input) => {
    const expected = input.meta.expected as string;
    const v = (input.patch as any).value;
    return typeof v === expected ? 'met' : 'unmet';
  },
});

// Mount a type-check constraint at root/b.a.
k.mount({
  id: 'type:b.a:number',
  anchor: { [SCOPE]: literal('root'), [REFPATH]: literal('b.a') },
  policy: StrictPolicy,        // unmet → preempt
  evalShape: 'check.type',
  meta: { expected: 'number' },
});

// Apply a patch: two walks, one batch.
const result = k.applyPatch({
  context: { [SCOPE]: 'root', [IDENTITY]: 'alice' },
  walks: [
    { [REFPATH]: 'b.a', value: 10 },   // type-check passes
    { [REFPATH]: 'b.b', value: 20 },   // no constraint mounted there
  ],
});
```

`result.walks` carries the per-walk matches and validities. `result.preempted`
flags whether a strict-policy `unmet` halted the patch. `result.totalHoist`
collects the constraints the kernel couldn't resolve locally — the outer
scope is expected to supply resolvers and re-run.

## Concepts

- **Patch**: `{ context, walks }`. Multi-walk by design — one logical
  operation can touch several anchors atomically. Walks are processed in
  order; later walks see facts mounted by earlier ones.
- **Constraint**: `{ id, anchor, policy, evalShape, emitShape?, inputs?, meta }`.
  `anchor` is a per-dimension pattern (`literal` / `wildcard` / `bind`);
  `evalShape` names a resolver registered with the kernel.
- **Validity**: three-valued — `met`, `unmet`, `undetermined`. `undetermined`
  is the kernel's way of saying "not enough info here; escalate".
- **Policy**: `Record<Validity, 'continue' | 'preempt' | 'hoist'>`. The
  three built-ins: `StrictPolicy`, `PermissivePolicy`, `GatePolicy`.
- **Preempt**: a single walk's `unmet` (under StrictPolicy) halts the
  rest of the patch.
- **Hoist**: an `undetermined` (or any `hoist` policy entry) pushes the
  constraint upward — the kernel records it on `totalHoist` /
  `totalUnresolvedHoists` for an outer scope to satisfy.
- **Emit**: a constraint's `emitShape` resolver returns more constraints
  to mount, hoist, or attach (used to build rules: head/where/body).

## Layout

```
src/
  types.ts         Coord / Patch / Walk / Pattern / Validity / Policy
  dimension.ts     DefaultDimension + dim helpers
  constraint.ts    Constraint shape, InputQuery, EmittedConstraint
  trie.ts          Anchor-pattern trie (the matcher)
  merge.ts         Walk merging, validity resolution
  kernel.ts        Kernel.applyPatch + mount + registerResolver
  resolver.ts      EvaluatorInput / EmitterInput / Registry
  smoke.ts         End-to-end example: type checks, gates, rules, escalation
  test/            assessable test suite
```

## Scripts

- `npm run build`  — `tsc -p tsconfig.build.json`
- `npm test`       — runs `dist/test-runner.js` (see `@console-one/assessable`)
- `npm run smoke`  — `node dist/smoke.js`

## Tests

5 cases via `@console-one/assessable`:

- multi-walk patch with type checks (3)
- rule head/where/body fires after second walk (1)
- escalation: missing resolver → undetermined → hoisted with shape preserved (1)

## License

MIT — see [LICENSE](./LICENSE).
