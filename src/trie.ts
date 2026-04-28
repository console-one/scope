// ─────────────────────────────────────────────────────────────────────────
// The store. Mounts ConstraintLikes (which include both Constraints and
// Facts — facts are walks that have landed and persist as leaves).
//
// matchWalkAgainstAll takes the effective columns of one walk and
// returns every mounted item whose anchor pattern matches, with
// the resulting bindings.
//
// walkToFact wraps a walk's effective columns as a fact: a leaf
// constraint with a literal anchor and resolved = the columns,
// ready to flow through merge as an upstream input for any
// downstream constraint that reads from those columns.
// ─────────────────────────────────────────────────────────────────────────

import { Coord, matchPatch, Bindings } from './types.js';
import { ConstraintLike } from './constraint.js';

export class Trie {
  private items = new Map<string, ConstraintLike>();

  mount(item: ConstraintLike): this {
    this.items.set(item.id, item);
    return this;
  }

  unmount(id: string): boolean {
    return this.items.delete(id);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  matchWalkAgainstAll(
    walkColumns: Record<string, Coord>,
  ): Array<{ item: ConstraintLike; bindings: Bindings }> {
    const out: Array<{ item: ConstraintLike; bindings: Bindings }> = [];
    for (const item of this.items.values()) {
      const b = matchPatch(item.anchor, walkColumns);
      if (b !== null) out.push({ item, bindings: b });
    }
    return out;
  }

  allCandidates(): ConstraintLike[] {
    return [...this.items.values()];
  }

  inventory(): string[] {
    return [...this.items.keys()];
  }
}

export function walkToFact(id: string, walkColumns: Record<string, Coord>): ConstraintLike {
  const anchor: Record<string, { kind: 'literal'; value: Coord }> = {};
  for (const [k, v] of Object.entries(walkColumns)) {
    anchor[k] = { kind: 'literal', value: v };
  }
  return {
    id,
    anchor,
    resolved: walkColumns,
    meta: { kind: 'fact' },
  };
}
