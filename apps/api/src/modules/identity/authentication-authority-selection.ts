/**
 * D5-P2 source-only authority selection.
 * Lazy factories guarantee that the inactive authority is not constructed.
 */
export function selectAuthenticationAuthority<T>(options: {
  nativeEnabled: boolean;
  legacy: () => T;
  native: () => T;
}): T {
  return options.nativeEnabled ? options.native() : options.legacy();
}
