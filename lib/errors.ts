export class AppError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 500 | 503,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
