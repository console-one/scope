// ─────────────────────────────────────────────────────────────────────────
// Dimensions are constraint-induced addressing axes. The kernel ships with
// two defaults (commit, scope); everything else is registered by user
// constraints that demand unique addressability of some component set.
//
// A dimension carries: comparison (so coords can be ordered/equality-tested),
// optional projection rules to other dimensions (so cross-dimensional
// addresses can be reconciled), and an optional propagation rule for diffs
// against parent/child/sibling positions.
// ─────────────────────────────────────────────────────────────────────────

import { Coord, DimensionTag } from './types.js';

export interface Dimension {
  tag: DimensionTag;
  // Three-way comparison; default is === / < / >.
  compare?(a: Coord, b: Coord): number;
  // Project a coord in this dimension to a coord in another dimension.
  // Returns undefined if no projection exists. Used to maintain anchor
  // equivalence classes across dimensions.
  projectTo?(target: DimensionTag, coord: Coord): Coord | undefined;
  // Diff propagation: when a coord at this dimension shifts, derive the
  // shifts to neighboring positions. Default is no propagation.
  propagate?(delta: unknown, kind: 'parent' | 'child' | 'sibling', coord: Coord): unknown;
}

export class DimensionRegistry {
  private dims = new Map<DimensionTag, Dimension>();

  register(d: Dimension): this {
    this.dims.set(d.tag, d);
    return this;
  }

  get(tag: DimensionTag): Dimension | undefined {
    return this.dims.get(tag);
  }

  has(tag: DimensionTag): boolean {
    return this.dims.has(tag);
  }

  tags(): DimensionTag[] {
    return [...this.dims.keys()];
  }

  // Default comparison if dimension didn't supply one.
  compare(tag: DimensionTag, a: Coord, b: Coord): number {
    const d = this.dims.get(tag);
    if (d?.compare) return d.compare(a, b);
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }
}

// ─── Default dimensions ──────────────────────────────────────────────────

// Commit: every patch belongs to a totally-ordered commit sequence.
// Numeric, monotonically increasing.
export const CommitDimension: Dimension = {
  tag: 'commit',
  compare: (a, b) => Number(a) - Number(b),
};

// Scope: lexical containment. Coords are scope identifiers; comparison is
// lexicographic on the path-string (parents have shorter paths than children).
export const ScopeDimension: Dimension = {
  tag: 'scope',
  compare: (a, b) => {
    const sa = String(a), sb = String(b);
    return sa === sb ? 0 : sa < sb ? -1 : 1;
  },
};

// Identity: who wrote this. Used by access-control constraints. No
// inherent ordering — coords are identity strings.
export const IdentityDimension: Dimension = {
  tag: 'identity',
};

export function defaultRegistry(): DimensionRegistry {
  const r = new DimensionRegistry();
  r.register(CommitDimension);
  r.register(ScopeDimension);
  r.register(IdentityDimension);
  return r;
}
