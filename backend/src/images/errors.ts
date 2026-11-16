// The picture services' one error type: a code Home can branch on, a sentence that says what to do, and the HTTP status.
export class ImageError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}
