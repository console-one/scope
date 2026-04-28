// ─────────────────────────────────────────────────────────────────────────
// The Kernel: mount, unmount, applyPatch.
//
// applyPatch processes a multi-walk patch:
//   1. Stamp _commit into context (shared across all walks).
//   2. For each walk in patch.walks:
//        a. Compute effective columns (context ∪ walk.columns).
//        b. Mount the walk as a fact so it's visible to downstream
//           constraints (including later walks of the same patch).
//        c. Run mergeWalk against the trie.
//        d. Persist the walk's mount emissions before processing the
//           next walk — coordinated writes within one patch do see
//           each other's effects in walk order.
//        e. If the walk preempted, halt subsequent walks and aggregate.
//   3. Aggregate per-walk results into a patch-level MergeResult.
//
// "Coordinated writes" means walks of the same patch share context
// (commit, identity), and later walks observe earlier walks' mounted
// emissions. Cross-patch ordering is by commit number.
// ─────────────────────────────────────────────────────────────────────────

import { Patch, COMMIT, Coord, effectiveColumns } from './types.js';
import { Dimension, DimensionRegistry, defaultRegistry } from './dimension.js';
import { Constraint, EmittedConstraint } from './constraint.js';
import { Trie, walkToFact } from './trie.js';
import { mergeWalk, MergeResult, WalkMergeResult } from './merge.js';
import { Registry, Resolver } from './resolver.js';

export interface KernelOptions {
  dimensions?: DimensionRegistry;
  resolvers?: Registry;
}

// Patch input: caller can pass either the explicit multi-walk shape or
// a single-walk shorthand (a flat record interpreted as one walk with
// no separate context).
export type PatchInput =
  | Patch
  | { context?: Record<string, Coord>; walks: Array<Record<string, Coord>> }
  | Record<string, Coord>;

export class Kernel {
  readonly dimensions: DimensionRegistry;
  readonly resolvers: Registry;
  readonly trie = new Trie();
  private patchCounter = 0;
  private factCounter = 0;

  constructor(opts: KernelOptions = {}) {
    this.dimensions = opts.dimensions ?? defaultRegistry();
    this.resolvers = opts.resolvers ?? new Registry();
  }

  registerResolver<I = any, O = any>(r: Resolver<I, O>): this {
    this.resolvers.register(r);
    return this;
  }

  defineDimension(d: Dimension): this {
    this.dimensions.register(d);
    return this;
  }

  mount(c: Constraint): this {
    this.trie.mount(c);
    return this;
  }

  unmount(id: string): boolean {
    return this.trie.unmount(id);
  }

  applyPatch(input: PatchInput): MergeResult {
    const patch = this.normalize(input);
    // Stamp the commit on the shared context.
    patch.context[COMMIT] = ++this.patchCounter;

    const walks: WalkMergeResult[] = [];
    const totalMount: EmittedConstraint[] = [];
    const totalHoist: EmittedConstraint[] = [];
    const totalUnresolved: MergeResult['totalUnresolvedHoists'] = [];
    let preempted = false;
    let preemptedBy: string | null = null;

    for (let i = 0; i < patch.walks.length; i++) {
      // Mount this walk as a fact so subsequent walks (and downstream
      // constraints in this same merge) can see it.
      const factId = `fact-${++this.factCounter}`;
      this.trie.mount(walkToFact(factId, effectiveColumns(patch, patch.walks[i])));

      const result = mergeWalk(patch, i, this.trie, this.resolvers);
      walks.push(result);

      // Persist this walk's mount emissions before the next walk runs.
      for (const e of result.mount) this.trie.mount(e.constraint);

      totalMount.push(...result.mount);
      totalHoist.push(...result.hoist);
      for (const u of result.unresolvedHoists) {
        totalUnresolved.push({ walkIndex: i, ...u });
      }

      if (result.preempted) {
        preempted = true;
        preemptedBy = result.preemptedBy;
        break; // halt subsequent walks
      }
    }

    return {
      patch,
      walks,
      preempted,
      preemptedBy,
      totalMount,
      totalHoist,
      totalUnresolvedHoists: totalUnresolved,
    };
  }

  // Coerce caller input into a normalized Patch.
  private normalize(input: PatchInput): Patch {
    const anyInput = input as any;
    if (Array.isArray(anyInput.walks)) {
      // Multi-walk form. Each walk may be either a flat columns record
      // or a {columns} wrapper — detect and unify.
      return {
        context: { ...(anyInput.context ?? {}) },
        walks: anyInput.walks.map((w: any) => {
          if (w && typeof w === 'object' && w.columns && typeof w.columns === 'object') {
            return { columns: { ...w.columns } };
          }
          return { columns: { ...w } };
        }),
      };
    }
    // Flat record — single-walk patch.
    return {
      context: {},
      walks: [{ columns: { ...(input as Record<string, Coord>) } }],
    };
  }
}
