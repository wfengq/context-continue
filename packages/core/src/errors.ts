export type ErrorCode =
  | 'BUDGET_TOO_SMALL'
  | 'STALE_VERSION'
  | 'INVALID_OP'
  | 'INVALID_PLAN'
  | 'NOT_A_MEMBER'
  | 'FORBIDDEN'
  | 'PROJECT_NOT_COMPLETE'
  | 'PROJECT_CLOSED'
  | 'NOT_FOUND';

export class ContextError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ContextError';
    this.code = code;
    this.details = details;
  }
}

export class BudgetTooSmallError extends ContextError {
  declare readonly details: { required: number; budget: number };

  constructor(required: number, budget: number) {
    super('BUDGET_TOO_SMALL', `Token budget ${budget} is too small; at least ${required} is required`, {
      required,
      budget,
    });
    this.name = 'BudgetTooSmallError';
  }
}
