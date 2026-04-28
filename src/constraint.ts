// ─────────────────────────────────────────────────────────────────────────
// Constraint as pure data; ConstraintLike resolves to either a constraint
// or a fact (a previously-mounted walk's effective columns).
// ─────────────────────────────────────────────────────────────────────────

import {
  AnchorPattern,
  Bindings,
  Coord,
  Policy,
  ShapeTag,
  matchPatch,
  substitute,
} from './types.js';

export interface InputQuery {
  pattern: AnchorPattern;
  as?: string;
  where?: (candidate: ConstraintLike, bindings: Bindings) => boolean;
}

export interface ConstraintLike {
  id: string;
  anchor: AnchorPattern;
  meta?: Record<string, unknown>;
  // For facts: the walk's effective columns. Empty/undefined for
  // unresolved constraints (their anchor is still a pattern).
  resolved?: Record<string, Coord>;
}

export interface EmittedConstraint {
  constraint: Constraint;
  destination: 'mount' | 'hoist';
}

export interface Constraint {
  id: string;
  anchor: AnchorPattern;
  policy: Policy;
  evalShape: ShapeTag;
  emitShape?: ShapeTag;
  inputs?: InputQuery[];
  meta?: Record<string, unknown>;
}

export function resolveQuery(
  q: InputQuery,
  candidates: ConstraintLike[],
  callerBindings: Bindings,
): ConstraintLike[] {
  const pattern = substitute(q.pattern, callerBindings);
  const matches: ConstraintLike[] = [];
  for (const c of candidates) {
    if (c.resolved) {
      const b = matchPatch(pattern, c.resolved, callerBindings);
      if (b !== null && (!q.where || q.where(c, b))) matches.push(c);
      continue;
    }
    if (anchorPatternsCompatible(pattern, c.anchor, callerBindings)) {
      if (!q.where || q.where(c, callerBindings)) matches.push(c);
    }
  }
  return matches;
}

function anchorPatternsCompatible(
  a: AnchorPattern,
  b: AnchorPattern,
  bindings: Bindings,
): boolean {
  const cols = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const col of cols) {
    const da = a[col];
    const db = b[col];
    if (!da || !db) continue;
    if (da.kind === 'literal' && db.kind === 'literal') {
      if (da.value !== db.value && String(da.value) !== String(db.value)) return false;
    }
    if (da.kind === 'literal' && db.kind === 'bind') {
      const bound = bindings[db.var];
      if (bound !== undefined && bound !== da.value && String(bound) !== String(da.value)) return false;
    }
    if (da.kind === 'bind' && db.kind === 'literal') {
      const bound = bindings[da.var];
      if (bound !== undefined && bound !== db.value && String(bound) !== String(db.value)) return false;
    }
  }
  return true;
}

export function toposort(
  constraints: Constraint[],
  inputMatches: Map<string, Map<string, ConstraintLike[]>>,
): Constraint[] {
  const byId = new Map(constraints.map((c) => [c.id, c]));
  const inDegree = new Map<string, number>();
  const successors = new Map<string, Set<string>>();
  for (const c of constraints) {
    inDegree.set(c.id, 0);
    successors.set(c.id, new Set());
  }
  for (const c of constraints) {
    const matches = inputMatches.get(c.id);
    if (!matches) continue;
    for (const candidates of matches.values()) {
      for (const cand of candidates) {
        if (!byId.has(cand.id)) continue;
        if (cand.id === c.id) continue;
        if (successors.get(cand.id)!.has(c.id)) continue;
        successors.get(cand.id)!.add(c.id);
        inDegree.set(c.id, inDegree.get(c.id)! + 1);
      }
    }
  }
  const queue = constraints.filter((c) => inDegree.get(c.id) === 0);
  const result: Constraint[] = [];
  while (queue.length > 0) {
    const c = queue.shift()!;
    result.push(c);
    for (const succ of successors.get(c.id) ?? []) {
      const next = inDegree.get(succ)! - 1;
      inDegree.set(succ, next);
      if (next === 0) queue.push(byId.get(succ)!);
    }
  }
  if (result.length !== constraints.length) {
    const remaining = constraints.filter((c) => !result.includes(c)).map((c) => c.id);
    throw new Error(`Cycle in constraint graph: ${remaining.join(', ')}`);
  }
  return result;
}
