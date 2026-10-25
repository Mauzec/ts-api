export class AppError extends Error {
  readonly details: unknown;
  readonly retryAt: number | undefined;
  readonly pause: boolean;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    options: { details?: unknown; retryAt?: number; pause?: boolean } = {},
  ) {
    super(message);
    this.name = "Application error";
    this.details = options.details;
    this.retryAt = options.retryAt;
    this.pause = options.pause ?? false;
  }
}
