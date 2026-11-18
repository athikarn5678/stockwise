/**
 * Whether an error handed to the ZXing reader callback is a decode exception,
 * meaning "this frame holds no readable barcode yet" (NotFoundException,
 * ChecksumException, FormatException, ...). The reader reports one for almost
 * every video frame, so none of them may stop the camera.
 *
 * Do NOT compare `error.name`: ts-custom-error sets it from the constructor
 * name, which a production minifier mangles ("NotFoundException" becomes "e"),
 * so a name check treats the first empty frame as a camera failure and stops
 * the stream. Every ZXing `Exception` exposes `getKind()` backed by a static
 * `kind` string that survives minification, so the decode kinds are matched on it; real camera and stream failures are
 * DOMExceptions and have no such method.
 */
/** `kind` values of the exceptions the reader raises for a frame with no readable barcode. */
const DECODE_KINDS = new Set([
  "NotFoundException",
  "ChecksumException",
  "FormatException",
  "ReaderException",
  "ReedSolomonException",
]);

export function isZxingDecodeException(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { getKind?: unknown };
  if (typeof candidate.getKind !== "function") return false;
  try {
    const kind: unknown = (candidate.getKind as () => unknown).call(error);
    // Other ZXing exceptions (IllegalArgument, IllegalState, ...) signal a real
    // fault, not an empty frame, and still stop the camera.
    return typeof kind === "string" && DECODE_KINDS.has(kind);
  } catch {
    return false;
  }
}
