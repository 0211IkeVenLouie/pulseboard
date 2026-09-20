export type AppErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'INVALID' | 'FORBIDDEN';

export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const httpStatusFor: Record<AppErrorCode, number> = {
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID: 400,
  FORBIDDEN: 403,
};
