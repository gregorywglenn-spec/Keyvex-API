/**
 * OAuth 2.1 resource-server validation for the KeyVex MCP Cloud Function.
 *
 * Validates incoming Bearer tokens that were issued by WorkOS AuthKit's
 * Connect product. Token shape, issuer URL, JWKS URI, and the `keyvex_tier`
 * claim are all locked by the architecture doc at
 * `docs/architecture-billing-and-auth.md` — verified against WorkOS docs
 * on 2026-05-21.
 *
 * The MCP function operates in dual-auth mode:
 *   1. Static `MCP_API_KEY` shared secret (legacy / admin path)
 *   2. WorkOS-issued OAuth 2.1 JWT (new per-customer path)
 * Either succeeds → request is authorized. Both fail → 401.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * WorkOS Production environment identifiers. These are not secrets — the
 * client_id appears in every public OAuth redirect URL. Treat as config.
 *
 * Source: GET /user_management/{client_id}/.well-known/openid-configuration
 *         executed against api.workos.com on 2026-05-21.
 */
const WORKOS_CLIENT_ID = "client_01KRV0ZQ4NAEQP995NJ088TTQ4";
const WORKOS_ISSUER = `https://api.workos.com/user_management/${WORKOS_CLIENT_ID}`;
const WORKOS_JWKS_URI = `https://api.workos.com/sso/jwks/${WORKOS_CLIENT_ID}`;

/**
 * The resource indicator that KeyVex MCP advertises as its OAuth `aud`.
 * WorkOS will only issue tokens with this `aud` if the resource has been
 * registered in the WorkOS dashboard at Connect → MCP resource indicators.
 * Registered on 2026-05-21.
 */
const MCP_AUDIENCE = "https://mcp.keyvex.com";

/**
 * JWKS fetched once and cached in memory by `jose` (default 10-min TTL).
 * Re-fetched automatically when WorkOS rotates signing keys.
 */
const remoteJWKS = createRemoteJWKSet(new URL(WORKOS_JWKS_URI), {
  cooldownDuration: 30_000, // ms between rotation-driven refetches
  timeoutDuration: 5_000,
});

export interface TokenContext {
  /** Authentication mechanism used. */
  authMethod: "static_key" | "oauth_jwt";
  /** Customer's tier. "admin" for static-key auth (legacy). */
  tier: "admin" | "pro" | "builder" | "free" | "unknown";
  /** WorkOS user ID (sub claim), or null for static-key auth. */
  workosUserId: string | null;
  /** Raw verified JWT payload, or null for static-key auth. */
  jwtPayload: JWTPayload | null;
}

/**
 * Result of an authentication attempt.
 * - `{ ok: true, context }`  → caller may proceed
 * - `{ ok: false, reason }`  → caller returns 401 with reason
 */
export type AuthResult =
  | { ok: true; context: TokenContext }
  | { ok: false; reason: string };

/**
 * Validate a Bearer token. Tries static-key match first (fastest), falls
 * back to JWT validation against WorkOS's JWKS.
 *
 * @param token        the raw token string from `Authorization: Bearer <token>`
 * @param staticKey    the value of the MCP_API_KEY secret (compared in constant time)
 */
export async function authenticate(
  token: string,
  staticKey: string,
): Promise<AuthResult> {
  if (!token) {
    return { ok: false, reason: "missing_bearer" };
  }

  // Path 1: legacy static-key auth. Used by existing programmatic API
  // customers and internal tooling until per-customer OAuth issuance ships.
  if (constantTimeEqual(token, staticKey)) {
    return {
      ok: true,
      context: {
        authMethod: "static_key",
        tier: "admin",
        workosUserId: null,
        jwtPayload: null,
      },
    };
  }

  // Path 2: WorkOS-issued OAuth JWT. Verifies signature against WorkOS JWKS,
  // checks issuer + audience, then extracts the `keyvex_tier` claim that
  // WorkOS's JWT template injects from user metadata.
  try {
    const { payload } = await jwtVerify(token, remoteJWKS, {
      issuer: WORKOS_ISSUER,
      audience: MCP_AUDIENCE,
    });

    const rawTier = payload["keyvex_tier"];
    const tier = normalizeTier(rawTier);
    const sub = typeof payload.sub === "string" ? payload.sub : null;

    return {
      ok: true,
      context: {
        authMethod: "oauth_jwt",
        tier,
        workosUserId: sub,
        jwtPayload: payload,
      },
    };
  } catch (err) {
    // Common cases: expired token, wrong issuer/audience, bad signature,
    // not a JWT at all. We collapse them into a single 401 — the client
    // doesn't need to know exactly why their token was rejected.
    const code = err instanceof Error ? err.message : "jwt_invalid";
    return { ok: false, reason: `invalid_token: ${code}` };
  }
}

function normalizeTier(value: unknown): TokenContext["tier"] {
  if (value === "pro" || value === "builder" || value === "free") {
    return value;
  }
  return "unknown";
}

/**
 * Timing-safe string comparison. Avoids leaking key-prefix information
 * through response-time differences.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * RFC 9728 Protected Resource Metadata document. Served at
 * `/.well-known/oauth-protected-resource` (no auth required) so MCP clients
 * can discover the authorization server they need to authenticate against.
 *
 * Spec: https://datatracker.ietf.org/doc/html/rfc9728
 */
export function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: MCP_AUDIENCE,
    authorization_servers: [WORKOS_ISSUER],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://keyvex.com",
  };
}
