// ─────────────────────────────────────────────────────────────────────────
// Merge processes one walk of a patch against the trie. The kernel
// iterates over a patch's walks and aggregates the per-walk results.
//
// Per walk:
//   1. Compute effective columns (patch.context ∪ walk.columns).
//   2. Match every mounted item whose anchor pattern accepts those columns.
//   3. Resolve each matched constraint's input queries against the
//      trie's full candidate set, with caller bindings flowing through.
//   4. Toposort by edges derived from inputMatches.
//   5. Walk the order. For each constraint:
//        - dispatch evalShape through the registry
//        - apply policy to validity (preempt/hoist/continue)
//        - if emitShape declared, dispatch it; collect emissions
//   6. Return per-walk MergeResult.
//
// Aggregation across walks happens in the kernel (mounts persist between
// walks of the same patch so later walks see earlier walks' emissions;
// preempt within a walk halts that walk; preempt at patch level is
// determined by the kernel's aggregation policy).
// ─────────────────────────────────────────────────────────────────────────

import { Patch, Validity, Bindings, Coord, effectiveColumns } from './types.js';
import {
  Constraint,
  ConstraintLike,
  EmittedConstraint,
  resolveQuery,
  toposort,
} from './constraint.js';
import { Trie } from './trie.js';
import { EvaluatorInput, EmitterInput, Registry, NoResolverError } from './resolver.js';

export interface WalkMergeResult {
  walkIndex: number;
  walkColumns: Record<string, Coord>;
  matched: Array<{
    constraint: Constraint;
    bindings: Bindings;
    validity: Validity;
    resolverError?: NoResolverError;
  }>;
  preempted: boolean;
  preemptedBy: string | null;
  hoist: EmittedConstraint[];
  mount: EmittedConstraint[];
  unresolvedHoists: Array<{ constraintId: string; shape: string }>;
}

export interface MergeResult {
  patch: Patch;
  walks: WalkMergeResult[];
  // Aggregated across walks for convenience.
  preempted: boolean;
  preemptedBy: string | null;
  totalMount: EmittedConstraint[];
  totalHoist: EmittedConstraint[];
  totalUnresolvedHoists: Array<{ walkIndex: number; constraintId: string; shape: string }>;
}

export function mergeWalk(
  patch: Patch,
  walkIndex: number,
  trie: Trie,
  registry: Registry,
): WalkMergeResult {
  const walk = patch.walks[walkIndex];
  const walkColumns = effectiveColumns(patch, walk);

  const allMatches = trie.matchWalkAgainstAll(walkColumns);
  const constraints: Array<{ constraint: Constraint; bindings: Bindings }> = [];
  for (const m of allMatches) {
    if (!m.item.resolved && isConstraint(m.item)) {
      constraints.push({ constraint: m.item, bindings: m.bindings });
    }
  }

  const candidates = trie.allCandidates();
  const inputMatches = new Map<string, Map<string, ConstraintLike[]>>();
  for (const { constraint, bindings } of constraints) {
    const perInput = new Map<string, ConstraintLike[]>();
    for (const [i, q] of (constraint.inputs ?? []).entries()) {
      perInput.set(q.as ?? `_in${i}`, resolveQuery(q, candidates, bindings));
    }
    inputMatches.set(constraint.id, perInput);
  }

  const order = toposort(
    constraints.map((c) => c.constraint),
    inputMatches,
  );
  const bindingsById = new Map(constraints.map((c) => [c.constraint.id, c.bindings]));

  const validities = new Map<string, Validity>();
  const matchedResults: WalkMergeResult['matched'] = [];
  const hoist: EmittedConstraint[] = [];
  const mount: EmittedConstraint[] = [];
  const unresolvedHoists: WalkMergeResult['unresolvedHoists'] = [];
  let preempted = false;
  let preemptedBy: string | null = null;

  for (const c of order) {
    if (preempted) break;
    const bindings = bindingsById.get(c.id) ?? {};
    const evalInput: EvaluatorInput = {
      patch: walkColumns,
      fullPatch: patch,
      walkIndex,
      bindings,
      inputMatches: inputMatches.get(c.id) ?? new Map(),
      resolutions: validities,
      visible: candidates,
      meta: c.meta ?? {},
    };

    let v: Validity;
    let resolverError: NoResolverError | undefined;
    try {
      v = registry.resolve(c.evalShape, evalInput);
    } catch (err) {
      if (err instanceof NoResolverError) {
        v = 'undetermined';
        resolverError = err;
        unresolvedHoists.push({ constraintId: c.id, shape: c.evalShape });
      } else {
        throw err;
      }
    }
    validities.set(c.id, v);
    matchedResults.push({ constraint: c, bindings, validity: v, resolverError });

    const action = c.policy[v];
    if (action === 'preempt') {
      preempted = true;
      preemptedBy = c.id;
    }
    if (action === 'hoist') hoist.push({ constraint: c, destination: 'hoist' });

    if (c.emitShape) {
      const emitInput: EmitterInput = { ...evalInput, validity: v };
      try {
        const emissions = registry.resolve<EmitterInput, EmittedConstraint[]>(
          c.emitShape,
          emitInput,
        );
        for (const e of emissions) {
          if (e.destination === 'mount') mount.push(e);
          else hoist.push(e);
        }
      } catch (err) {
        if (err instanceof NoResolverError) {
          unresolvedHoists.push({ constraintId: c.id, shape: c.emitShape });
        } else {
          throw err;
        }
      }
    }
  }

  return {
    walkIndex,
    walkColumns,
    matched: matchedResults,
    preempted,
    preemptedBy,
    hoist,
    mount,
    unresolvedHoists,
  };
}

function isConstraint(item: ConstraintLike): item is Constraint {
  return typeof (item as Constraint).evalShape === 'string';
}
