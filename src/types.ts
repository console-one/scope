// ─────────────────────────────────────────────────────────────────────────
// Core types: Patches, Anchor patterns, Bindings, Validity, Policy.
//
// A "patch" is just a record. Columns named with reserved tags (the
// default dimensions: _commit, _scope, _identity, _refpath) contribute
// to addressing; everything else is payload — but nothing in the kernel
// privileges those columns. They're conventions, not special cases.
//
// Constraint anchors are patterns over patch columns. Patterns admit
// literals, wildcards, and binding variables. When a patch is matched
// against a constraint's anchor pattern, the result is a binding map
// that substitutes through the constraint's evaluate, emit, and
// dependency queries.
// ─────────────────────────────────────────────────────────────────────────

export type Coord = unknown; // any column value; the matcher does its own equality
export type DimensionTag = string;

// Default dimension column names. Constraints addressing the kernel's
// built-in addressing dimensions reference these. User dimensions are
// just other column names.
export const COMMIT = '_commit';
export const SCOPE = '_scope';
export const IDENTITY = '_identity';
export const REFPATH = '_refpath';

// A patch is a coordinated set of Walks plus a shared context. Each walk
// is one column-update landing at its own anchor — `b = { a: 10, b: 20 }`
// is one patch with two walks (b.a=10 and b.b=20). The context columns
// (commit, identity, lineage) are shared across all walks of the same
// patch and flow into each walk's matching as if they were walk-local
// columns. The split between context and walk columns is for the caller's
// convenience; the kernel treats walks individually with effective
// columns = context ∪ walk.columns.
export interface Walk {
  columns: Record<string, Coord>;
}

export interface Patch {
  context: Record<string, Coord>;
  walks: Walk[];
}

// Single-anchor convenience: lift a flat column bag into a one-walk patch.
export function singleWalk(columns: Record<string, Coord>, contextKeys: string[] = []): Patch {
  const context: Record<string, Coord> = {};
  const walkColumns: Record<string, Coord> = {};
  for (const [k, v] of Object.entries(columns)) {
    if (contextKeys.includes(k)) context[k] = v;
    else walkColumns[k] = v;
  }
  return { context, walks: [{ columns: walkColumns }] };
}

// Effective columns for one walk = patch context merged with walk columns.
// Walk columns win on conflict (a walk can override patch-level defaults).
export function effectiveColumns(patch: Patch, walk: Walk): Record<string, Coord> {
  return { ...patch.context, ...walk.columns };
}

// ─── Anchor patterns ─────────────────────────────────────────────────────

export type PatternDim =
  // exact match required
  | { kind: 'literal'; value: Coord }
  // any value matches; doesn't bind
  | { kind: 'wildcard' }
  // any value matches; binds the captured value to the named variable
  | { kind: 'bind'; var: string }
  // value-level predicate; sees the candidate coord and current bindings
  | { kind: 'pred'; pred: (coord: Coord, bindings: Bindings) => boolean };

// AnchorPattern names which columns the constraint addresses and how.
// Columns absent from the pattern are unrestricted.
export type AnchorPattern = Record<string, PatternDim>;

export type Bindings = Record<string, Coord>;

export const literal = (value: Coord): PatternDim => ({ kind: 'literal', value });
export const wildcard = (): PatternDim => ({ kind: 'wildcard' });
export const bind = (varName: string): PatternDim => ({ kind: 'bind', var: varName });
export const pred = (
  fn: (coord: Coord, bindings: Bindings) => boolean,
): PatternDim => ({ kind: 'pred', pred: fn });

// Match a column bag against a pattern. Returns the resulting bindings if
// every column the pattern names is satisfied, or null on mismatch.
// Pre-existing bindings (passed in) are extended; if a `bind` pattern
// names a variable already bound to a different value, the match fails.
//
// (Takes a flat Record, not the multi-walk Patch — patches are split
// into per-walk effective columns by the kernel before matching.)
export function matchPatch(
  pattern: AnchorPattern,
  patch: Record<string, Coord>,
  inherited: Bindings = {},
): Bindings | null {
  const bindings: Bindings = { ...inherited };
  for (const [col, dim] of Object.entries(pattern)) {
    const v = patch[col];
    if (v === undefined) return null;
    switch (dim.kind) {
      case 'literal':
        if (!coordEqual(v, dim.value)) return null;
        break;
      case 'wildcard':
        break;
      case 'bind': {
        const existing = bindings[dim.var];
        if (existing !== undefined && !coordEqual(existing, v)) return null;
        bindings[dim.var] = v;
        break;
      }
      case 'pred':
        if (!dim.pred(v, bindings)) return null;
        break;
    }
  }
  return bindings;
}

// Substitute bindings into a pattern: any `bind` whose var is already
// bound becomes a `literal` of the bound value. Used when a constraint's
// dependency query inherits bindings from the constraint's own match.
export function substitute(pattern: AnchorPattern, bindings: Bindings): AnchorPattern {
  const out: AnchorPattern = {};
  for (const [col, dim] of Object.entries(pattern)) {
    if (dim.kind === 'bind' && bindings[dim.var] !== undefined) {
      out[col] = { kind: 'literal', value: bindings[dim.var] };
    } else {
      out[col] = dim;
    }
  }
  return out;
}

function coordEqual(a: Coord, b: Coord): boolean {
  if (a === b) return true;
  // Numeric/string interop: '42' equals 42 for matching convenience.
  if ((typeof a === 'string' || typeof a === 'number') && (typeof b === 'string' || typeof b === 'number')) {
    return String(a) === String(b);
  }
  return false;
}

// ─── Validity & policy ──────────────────────────────────────────────────

export type Validity = 'met' | 'unmet' | 'undetermined';
export type Action = 'preempt' | 'hoist' | 'continue';
export type Policy = Record<Validity, Action>;

export const StrictPolicy: Policy = { met: 'continue', unmet: 'preempt', undetermined: 'hoist' };
export const PermissivePolicy: Policy = { met: 'continue', unmet: 'continue', undetermined: 'continue' };
export const GatePolicy: Policy = { met: 'hoist', unmet: 'continue', undetermined: 'continue' };

// ─── Hoist shapes ────────────────────────────────────────────────────────
//
// A ShapeTag names a hoist's contract. Resolvers register against tags;
// constraints declare the tags they use for evaluation and emission.
// The runtime dispatches by tag — every "function call" in the system
// is a tag lookup followed by an invocation.

export type ShapeTag = string;
