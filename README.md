# @console-one/scope

## What it is

A small constraint-propagation kernel over multi-dimensional anchors. A patch is a
`(context, [walks])` batch; the kernel runs each walk against a trie of mounted
constraints, later walks see facts mounted by earlier ones, and every matched constraint
resolves to a three-valued verdict with a per-verdict policy deciding what happens next.
This repo is part of a multi-year investigation into typed, budgeted, event-sourced
coordination substrates; each package in the family isolates one question.

## The question it answers

How does ONE constraint kernel drive access control, typing, gates, and lifecycle with
three-valued verdicts (`met` / `unmet` / `undetermined`) plus per-verdict policies
(`continue` / `preempt` / `hoist`) — instead of a kernel per domain?

The kernel doesn't know which domain it's serving; the difference is which `evalShape` a
resolver is registered for. Access control wants binary deny (`unmet` → `preempt`); type
checking needs "not enough info yet" distinct from "wrong" (`undetermined`); lifecycle
gates need to escalate upward (`hoist`: the constraint is pushed to an outer scope, which
supplies the missing resolver and re-runs). The verdict→action table is the finding:
*preempt* and *hoist* are different rules with different destinations — one kills the rest
of the patch, the other names which outer scope owns the suspended judgment's resumption.

## Quick start

```ts
import {
  Kernel, literal, REFPATH, SCOPE, IDENTITY,
  StrictPolicy, type EvaluatorInput, Validity,
} from '@console-one/scope';

const k = new Kernel();

k.registerResolver<EvaluatorInput, Validity>({
  shape: 'check.type',
  fn: (input) => {
    const expected = input.meta.expected as string;
    const v = (input.patch as any).value;
    return typeof v === expected ? 'met' : 'unmet';
  },
});

k.mount({
  id: 'type:b.a:number',
  anchor: { [SCOPE]: literal('root'), [REFPATH]: literal('b.a') },
  policy: StrictPolicy,        // unmet → preempt
  evalShape: 'check.type',
  meta: { expected: 'number' },
});

const result = k.applyPatch({
  context: { [SCOPE]: 'root', [IDENTITY]: 'alice' },
  walks: [
    { [REFPATH]: 'b.a', value: 10 },   // type-check passes
    { [REFPATH]: 'b.b', value: 20 },   // no constraint mounted there
  ],
});
```

`result.walks` carries per-walk matches and verdicts; `result.preempted` flags whether a
strict-policy `unmet` halted the patch; `result.totalHoist` collects constraints the
kernel couldn't resolve locally, for an outer scope to satisfy and re-run.

## Concepts

- **Patch**: `{ context, walks }` — one logical operation touching several anchors
  atomically, walks processed in order.
- **Constraint**: `{ id, anchor, policy, evalShape, emitShape?, inputs?, meta }`;
  `anchor` is a per-dimension pattern (`literal` / `wildcard` / `bind`).
- **Validity**: `met` / `unmet` / `undetermined` — the third value means "not enough
  info here; escalate", preserving the unresolved shape for the outer scope.
- **Policy**: `Record<Validity, 'continue' | 'preempt' | 'hoist'>`. Built-ins:
  `StrictPolicy`, `PermissivePolicy`, `GatePolicy`.
- **Emit**: a constraint's `emitShape` resolver returns more constraints to mount, hoist,
  or attach (used to build head/where/body rules).

## Status, stated plainly

v0.1.x, builds, 5 test cases (multi-walk type checks; a head/where/body rule firing after
a second walk; escalation: missing resolver → `undetermined` → hoisted with shape
preserved). Extracted out of `fieldtype` (which shed its duplicate); a sibling kernel with
no production consumers. One known design debt, recorded honestly: anchor patterns admit
closure predicates (`pred`), which makes those constraints opaque to backward analysis —
the sister prototype `plane` demonstrated why every law should be invertible data instead.

## Where the idea lives now

The three-valued semantics carry forward: the successor kernel,
[`@console-one/sequence`](https://github.com/console-one/sequence) (v2), suspends and
watches `where`-gated blocks rather than rejecting them — suspension-over-rejection is
this kernel's verdict table generalized.

## Development

```sh
npm run build   # tsc -p tsconfig.build.json
npm test        # dist/test-runner.js (@console-one/assessable)
npm run smoke   # node dist/smoke.js — type checks, gates, rules, escalation
```

MIT — see [LICENSE](./LICENSE).
