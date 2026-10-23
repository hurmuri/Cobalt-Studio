export class AppError extends Error {
  constructor(message, { status = 400, code = 'app.bad_request', details } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function errorPayload(error) {
  return {
    ok: false,
    error: {
      code: error.code || 'app.internal',
      message: error.message || '内部错误',
      ...(error.details ? { details: error.details } : {}),
    },
  };
}
