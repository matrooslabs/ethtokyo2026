export type WorldChallengeToken = {
  kind: "challenge";
  challengeId: string;
  wallet: string;
  difficulty: "easy" | "hard";
  nonce: string;
  message: string;
  action: string;
  environment: string;
  expiresAt: number;
};

export type WorldAttestationToken = {
  kind: "attestation";
  challengeId: string;
  wallet: string;
  difficulty: "easy" | "hard";
  commitment: string;
  action: string;
  environment: string;
  expiresAt: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const keyDomain = encoder.encode("versu:world-claim-token:hmac:v1\0");
const maxTokenLength = 4096;
const maxLifetimeSeconds = 24 * 60 * 60;
const hex32 = /^0x[0-9a-fA-F]{64}$/;
const base64url = /^[A-Za-z0-9_-]+$/;
const commonFields = ["kind", "challengeId", "wallet", "difficulty", "action", "environment", "expiresAt"];
const challengeFields = [...commonFields, "nonce", "message"];
const attestationFields = [...commonFields, "commitment"];

type WorldToken = WorldChallengeToken | WorldAttestationToken;

function validPayload(value: unknown, kind: WorldToken["kind"]): value is WorldToken {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = Object.keys(value);
  const expected = kind === "challenge" ? challengeFields : attestationFields;
  if (fields.length !== expected.length || !fields.every((field) => expected.includes(field))) return false;
  const token = value as Record<string, unknown>;
  if (token.kind !== kind || typeof token.challengeId !== "string" || !hex32.test(token.challengeId) ||
      typeof token.wallet !== "string" || !hex32.test(token.wallet) ||
      (token.difficulty !== "easy" && token.difficulty !== "hard") ||
      typeof token.action !== "string" || token.action.length === 0 ||
      typeof token.environment !== "string" || token.environment.length === 0 ||
      typeof token.expiresAt !== "number" || !Number.isSafeInteger(token.expiresAt) || token.expiresAt <= 0)
    return false;
  return kind === "challenge"
    ? typeof token.nonce === "string" && hex32.test(token.nonce) &&
        typeof token.message === "string" && token.message.length > 0
    : typeof token.commitment === "string" && hex32.test(token.commitment);
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(value: string): Uint8Array<ArrayBuffer> | null {
  if (!base64url.test(value) || value.length % 4 === 1) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
    return encode(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

async function signingKey(rpSigningKeyHex: string): Promise<CryptoKey> {
  if (typeof rpSigningKeyHex !== "string" || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(rpSigningKeyHex))
    throw new TypeError("Invalid World ID RP signing key");
  const hex = rpSigningKeyHex.replace(/^0x/, "");
  const material = new Uint8Array(keyDomain.length + 32);
  material.set(keyDomain);
  for (let index = 0; index < 32; index++)
    material[keyDomain.length + index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  const derived = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function sealWorldToken(payload: WorldToken, rpSigningKeyHex: string): Promise<string> {
  if (!validPayload(payload, payload?.kind)) throw new TypeError("Invalid World claim token payload");
  const now = Math.floor(Date.now() / 1000);
  if (payload.expiresAt <= now || payload.expiresAt > now + maxLifetimeSeconds)
    throw new TypeError("World claim token expiry is outside the allowed lifetime");
  const encodedPayload = encode(encoder.encode(JSON.stringify(payload)));
  if (encodedPayload.length + 44 > maxTokenLength) throw new TypeError("World claim token is too long");
  const signature = await crypto.subtle.sign("HMAC", await signingKey(rpSigningKeyHex), encoder.encode(encodedPayload));
  return `${encodedPayload}.${encode(new Uint8Array(signature))}`;
}

export async function openWorldToken<T>(token: string, rpSigningKeyHex: string,
  kind: "challenge" | "attestation", nowSeconds = Math.floor(Date.now() / 1000)): Promise<T | null> {
  if (typeof token !== "string" || token.length > maxTokenLength ||
      (kind !== "challenge" && kind !== "attestation") ||
      !Number.isSafeInteger(nowSeconds) || nowSeconds < 0) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || parts[1].length !== 43) return null;
  const payloadBytes = decode(parts[0]);
  const signature = decode(parts[1]);
  if (!payloadBytes || !signature || signature.length !== 32) return null;
  try {
    const key = await signingKey(rpSigningKeyHex);
    if (!await crypto.subtle.verify("HMAC", key, signature, encoder.encode(parts[0]))) return null;
    const payload: unknown = JSON.parse(decoder.decode(payloadBytes));
    return validPayload(payload, kind) && payload.expiresAt > nowSeconds ? payload as T : null;
  } catch {
    return null;
  }
}
