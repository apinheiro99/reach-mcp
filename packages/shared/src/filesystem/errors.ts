// Deterministic filesystem refusal codes shared by every REACH component. Callers branch on `code`, never on the message.

export type FsErrorCode =
  | "OUTSIDE_ROOT"
  | "DENIED"
  | "NOT_FOUND"
  | "NOT_FILE"
  | "NOT_DIRECTORY"
  | "TOO_LARGE"
  | "BINARY"
  | "UNSUPPORTED_FORMAT"
  | "DIMENSIONS_TOO_LARGE"
  | "INVALID_ARGUMENT"
  | "SYMLINK_REFUSED";

export class FsError extends Error {
  readonly code: FsErrorCode;

  constructor(code: FsErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
