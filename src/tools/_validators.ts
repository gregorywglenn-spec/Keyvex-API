/**
 * Shared input-validation utilities for MCP tool handlers.
 *
 * Purpose: smooth the local-vs-wire gap. MCP transport can serialize a
 * caller-side native boolean as the JSON string "true"/"false" depending on
 * which client SDK is in the loop, which Claude turn synthesized the call,
 * etc. A strict `typeof === "boolean"` check rejects those serializations
 * with an INTERNAL_ERROR — exactly the wire trap caught on v0.52.0 against
 * `include_non_open_market`.
 *
 * The helpers below standardize coercion across every tool so the trap
 * never bites a different parameter on a different tool that we didn't
 * happen to field-test.
 */

/**
 * Coerce a tool-argument value into a strict boolean.
 *
 * Accepts:
 *   - `true` / `false` (native boolean)
 *   - `"true"` / `"false"` (string serialization from wire)
 *
 * Throws (loud, descriptive) on:
 *   - any other value (numbers, other strings, null, objects, arrays, etc.)
 *
 * Critical: this helper NEVER silently defaults a bad input to `false`.
 * Per Greg's v0.52.1 directive: "If a caller passes garbage, a typo, or an
 * unhandled type, it will throw a loud, descriptive error." Silent
 * defaults would re-create the Tourniquet bug at the parameter layer.
 *
 * Example callsite (replaces strict typeof check):
 *
 *   if (args.is_derivative !== undefined) {
 *     out.is_derivative = parseBooleanArg(args.is_derivative, "is_derivative");
 *   }
 */
export function parseBooleanArg(
  value: unknown,
  fieldName: string,
): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(
    `Validation Error: [${fieldName}] must be a boolean or a valid serialization string ("true" or "false"). Got ${typeof value}: ${JSON.stringify(value)}`,
  );
}
