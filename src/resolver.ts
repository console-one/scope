// ─────────────────────────────────────────────────────────────────────────
// Resolvers and the Registry — same shape as before, but EvaluatorInput
// now carries both the current walk's effective columns (the convenient
// flat record evaluators usually want) AND the full multi-walk Patch
// (for resolvers that need to reason about sibling walks of the same
// patch — coordinated writes, cross-walk transactions, etc.).
// ─────────────────────────────────────────────────────────────────────────

import { ShapeTag, Patch, Validity, Bindings, Coord } from './types.js';
import { ConstraintLike, EmittedConstraint } from './constraint.js';

export interface EvaluatorInput {
  // Effective columns of the current walk (patch.context ∪ walk.columns).
  // Resolvers reading single-walk semantics use this.
  patch: Record<string, Coord>;
  // The full multi-walk patch this walk belongs to.
  fullPatch: Patch;
  // Index of the current walk inside fullPatch.walks.
  walkIndex: number;
  bindings: Bindings;
  inputMatches: Map<string, ConstraintLike[]>;
  resolutions: Map<string, Validity>;
  visible: ConstraintLike[];
  meta: Record<string, unknown>;
}

export interface EmitterInput extends EvaluatorInput {
  validity: Validity;
}

export interface Resolver<I = any, O = any> {
  shape: ShapeTag;
  fn: (input: I) => O;
  cost?: number;
  identity?: string;
  applicable?: (input: I) => boolean;
}

export class Registry {
  private byShape = new Map<ShapeTag, Resolver[]>();

  register<I = any, O = any>(r: Resolver<I, O>): this {
    let bucket = this.byShape.get(r.shape);
    if (!bucket) this.byShape.set(r.shape, (bucket = []));
    bucket.push(r as Resolver);
    return this;
  }

  candidates(shape: ShapeTag): Resolver[] {
    return this.byShape.get(shape) ?? [];
  }

  has(shape: ShapeTag): boolean {
    const bucket = this.byShape.get(shape);
    return !!bucket && bucket.length > 0;
  }

  resolve<I = any, O = any>(shape: ShapeTag, input: I): O {
    const cands = this.candidates(shape);
    const applicable = cands.filter((r) => !r.applicable || r.applicable(input));
    if (applicable.length === 0) throw new NoResolverError(shape);
    applicable.sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0));
    return applicable[0].fn(input) as O;
  }

  shapes(): ShapeTag[] {
    return [...this.byShape.keys()];
  }
}

export class NoResolverError extends Error {
  constructor(public shape: ShapeTag) {
    super(`No resolver registered for shape: ${shape}`);
  }
}

export type EvaluatorResolver = Resolver<EvaluatorInput, Validity>;
export type EmitterResolver = Resolver<EmitterInput, EmittedConstraint[]>;
