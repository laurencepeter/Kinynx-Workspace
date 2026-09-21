/**
 * Access tokens (short-lived JWTs) and refresh tokens (opaque, hashed at rest).
 * The auth *mechanism* is abstracted here so SSO/OIDC/SAML can issue the same
 * session shape later without touching route logic.
 */
import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

export interface AccessClaims {
  sub: string; // user id
  email: string;
}

export function makeSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signAccessToken(
  claims: AccessClaims,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ email: claims.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .setIssuer("kinynx")
    .sign(makeSecret(secret));
}

export async function verifyAccessToken(token: string, secret: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, makeSecret(secret), { issuer: "kinynx" });
  return { sub: String(payload.sub), email: String(payload.email ?? "") };
}

/** Generate a raw refresh token and its storage hash. Store only the hash. */
export function newRefreshToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
