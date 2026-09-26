// Server-only Cloudflare bindings: WORLD_ID_DB (D1; apply migrations/0001_world_identity.sql),
// WORLD_ID_APP_ID, WORLD_ID_RP_ID, WORLD_ID_RP_SIGNING_KEY (secret), WORLD_ID_ACTION
// (registered in the Portal), WORLD_ID_ENVIRONMENT (production/staging/sandbox).
// To authorize Sui paid play: SUI_NETWORK, SUI_RPC_URL, SUI_IDENTITY_PRIVATE_KEY
// (secret; sui1... Ed25519 owner of IdentityCap), SUI_IDENTITY_PACKAGE_ID, SUI_IDENTITY_COIN_TYPE,
// SUI_IDENTITY_ROUNDS (JSON {"YYYY-MM-DD":{"competitionId":"0x...","identityCapId":"0x..."}}).
// Never expose signing keys or the round object map through VITE_ variables.
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { signRequest } from "@worldcoin/idkit-core/signing";
import { env } from "cloudflare:workers";

type IdentityEnv = {
  WORLD_ID_DB?: D1Database;
  WORLD_ID_APP_ID?: string;
  WORLD_ID_RP_ID?: string;
  WORLD_ID_RP_SIGNING_KEY?: string;
  WORLD_ID_ACTION?: string;
  WORLD_ID_ENVIRONMENT?: string;
  SUI_NETWORK?: string;
  SUI_RPC_URL?: string;
  SUI_IDENTITY_PRIVATE_KEY?: string;
  SUI_IDENTITY_PACKAGE_ID?: string;
  SUI_IDENTITY_ROUNDS?: string;
  SUI_IDENTITY_COIN_TYPE?: string;
};

type IdentityConfig = Required<Pick<IdentityEnv, "WORLD_ID_DB" | "WORLD_ID_APP_ID" | "WORLD_ID_RP_ID" |
  "WORLD_ID_RP_SIGNING_KEY" | "WORLD_ID_ACTION" | "WORLD_ID_ENVIRONMENT">> & IdentityEnv;
const json = (body: object, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
const error = (code: string, status: number) => json({ error: code }, status);
const addressPattern = /^0x[0-9a-fA-F]{1,64}$/;
const hex32 = /^0x[0-9a-fA-F]{1,64}$/;
const noncePattern = /^0x[0-9a-fA-F]{64}$/;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function walletAddress(value: unknown): string | null {
  return text(value) && addressPattern.test(value) ? normalizeSuiAddress(value) : null;
}
function canonicalNullifier(value: unknown): string | null {
  if (!text(value) || !hex32.test(value)) return null;
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}
function utcRound() {
  return new Date().toISOString().slice(0, 10);
}
// World nullifiers are RP-scoped private identifiers; only publish a round-specific commitment.
async function onchainNullifier(round: string, nullifier: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const roundId = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`versu:${round}`)));
  const domain = encoder.encode("versu:world-id:round:v1");
  const commitment = new Uint8Array(domain.length + roundId.length + 32);
  commitment.set(domain);
  commitment.set(roundId, domain.length);
  const hex = nullifier.slice(2);
  for (let index = 0; index < 32; index++) {
    commitment[domain.length + roundId.length + index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", commitment));
}
function configured(): IdentityConfig | null {
  const c = env as unknown as IdentityEnv;
  if (!c.WORLD_ID_DB || !/^app_[a-zA-Z0-9_-]+$/.test(c.WORLD_ID_APP_ID ?? "") ||
      !/^rp_[a-zA-Z0-9_-]+$/.test(c.WORLD_ID_RP_ID ?? "") ||
      !/^(0x)?[a-fA-F0-9]{64}$/.test(c.WORLD_ID_RP_SIGNING_KEY ?? "") ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(c.WORLD_ID_ACTION ?? "") ||
      !["production", "staging", "sandbox"].includes(c.WORLD_ID_ENVIRONMENT ?? "")) {
    return null;
  }
  return c as IdentityConfig;
}
async function body(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json") ||
      Number(request.headers.get("content-length") ?? 0) > 100_000) return null;
  try {
    const value: unknown = await request.json();
    return record(value) ? value : null;
  } catch {
    return null;
  }
}

export async function challenge(request: Request): Promise<Response> {
  const c = configured();
  if (!c) return error("identity_not_configured", 503);
  const data = await body(request);
  const wallet = walletAddress(data?.wallet);
  if (!wallet) return error("invalid_wallet", 400);
  const round = utcRound();
  const signal = `${round}:${wallet}`;
  const rp = signRequest({ signingKeyHex: c.WORLD_ID_RP_SIGNING_KEY, action: c.WORLD_ID_ACTION });
  const message = `versu World ID wallet verification\nround: ${round}\nwallet: ${wallet}\nnonce: ${rp.nonce}\naction: ${c.WORLD_ID_ACTION}\n`;
  // Challenge expiry is also bounded by UTC midnight, so a proof cannot be carried to another round.
  const expires = Math.min(rp.expiresAt, (Date.parse(`${round}T00:00:00Z`) + 86_400_000) / 1000);
  try {
    await c.WORLD_ID_DB.prepare(
      "INSERT INTO world_identity_challenges (nonce, round, wallet, action, environment, message, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(rp.nonce, round, wallet, c.WORLD_ID_ACTION, c.WORLD_ID_ENVIRONMENT, message, expires).run();
  } catch {
    return error("identity_storage_unavailable", 503);
  }
  return json({ app_id: c.WORLD_ID_APP_ID, rp_id: c.WORLD_ID_RP_ID, action: c.WORLD_ID_ACTION,
    environment: c.WORLD_ID_ENVIRONMENT, round, signal, message,
    rp_context: { rp_id: c.WORLD_ID_RP_ID, nonce: rp.nonce, created_at: rp.createdAt,
      expires_at: rp.expiresAt, signature: rp.sig } });
}

type Challenge = { round: string; wallet: string; action: string; environment: string;
  message: string; expires_at: number; consumed: number };
type AuthenticatedWallet = { wallet: string; nonce: string; challenge: Challenge };
async function authenticate(c: IdentityConfig, data: Record<string, unknown>): Promise<AuthenticatedWallet | null> {
  const wallet = walletAddress(data.wallet);
  const nonce = data.nonce;
  if (!wallet || !text(nonce) || !noncePattern.test(nonce) || !text(data.signature)) return null;
  const challenge = await c.WORLD_ID_DB.prepare(
    "SELECT round, wallet, action, environment, message, expires_at, consumed FROM world_identity_challenges WHERE nonce = ?",
  ).bind(nonce).first<Challenge>();
  if (!challenge || challenge.wallet !== wallet || challenge.round !== utcRound() ||
      challenge.action !== c.WORLD_ID_ACTION || challenge.environment !== c.WORLD_ID_ENVIRONMENT ||
      challenge.expires_at <= Date.now() / 1000) return null;
  try {
    const network = c.SUI_NETWORK && c.SUI_RPC_URL
      ? new SuiGrpcClient({ baseUrl: c.SUI_RPC_URL, network: c.SUI_NETWORK as "testnet" | "mainnet" | "devnet" | "localnet" })
      : undefined;
    await verifyPersonalMessageSignature(new TextEncoder().encode(challenge.message), data.signature,
      { address: wallet, client: network });
  } catch {
    return null;
  }
  return { wallet, nonce, challenge };
}

function validProof(proof: unknown, nonce: string, challenge: Challenge): proof is Record<string, unknown> {
  if (!record(proof) || proof.protocol_version !== "4.0" || proof.nonce !== nonce ||
      proof.action !== challenge.action || proof.environment !== challenge.environment ||
      !Array.isArray(proof.responses) || proof.responses.length !== 1) return false;
  const response = proof.responses[0];
  return record(response) && response.identifier === "proof_of_human" && response.issuer_schema_id === 1 &&
    canonicalNullifier(response.nullifier) !== null &&
    text(response.signal_hash) &&
    /^0x[0-9a-fA-F]+$/.test(response.signal_hash) &&
    BigInt(response.signal_hash) === BigInt(hashSignal(`${challenge.round}:${challenge.wallet}`)) &&
    Array.isArray(response.proof) && response.proof.length === 5 && !proof.session_id;
}

function verifiedNullifier(result: unknown, proof: Record<string, unknown>, challenge: Challenge) {
  if (!record(result) || result.success !== true || result.action !== challenge.action ||
      result.environment !== challenge.environment || !Array.isArray(result.results) || result.results.length !== 1) return null;
  const item = result.results[0];
  const submitted = (proof.responses as Record<string, unknown>[])[0];
  const nullifier = canonicalNullifier(submitted.nullifier);
  if (!record(item) || item.identifier !== "proof_of_human" || item.success !== true ||
      (canonicalNullifier(item.nullifier) !== null && canonicalNullifier(item.nullifier) !== nullifier) ||
      (canonicalNullifier(result.nullifier) !== null && canonicalNullifier(result.nullifier) !== nullifier)) return null;
  return nullifier;
}

export async function verify(request: Request): Promise<Response> {
  const c = configured();
  if (!c) return error("identity_not_configured", 503);
  const data = await body(request);
  if (!data) return error("invalid_request", 400);
  let auth: AuthenticatedWallet | null;
  try { auth = await authenticate(c, data); } catch { return error("identity_storage_unavailable", 503); }
  if (!auth || auth.challenge.consumed !== 0 || !validProof(data.proof, auth.nonce, auth.challenge))
    return error("invalid_identity_proof", 400);
  const portal = c.WORLD_ID_ENVIRONMENT === "staging"
    ? "https://staging-developer.worldcoin.org"
    : "https://developer.world.org";
  let result: unknown;
  try {
    const res = await fetch(`${portal}/api/v4/verify/${c.WORLD_ID_RP_ID}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data.proof),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return error("identity_proof_rejected", 400);
    result = await res.json();
  } catch {
    return error("identity_verifier_unavailable", 503);
  }
  const nullifier = verifiedNullifier(result, data.proof, auth.challenge);
  if (!nullifier) return error("identity_proof_rejected", 400);
  try {
    const claimed = await c.WORLD_ID_DB.prepare(
      "UPDATE world_identity_challenges SET consumed = 1 WHERE nonce = ? AND consumed = 0 AND expires_at > ?",
    ).bind(auth.nonce, Date.now() / 1000).run();
    if (claimed.meta.changes !== 1) return error("identity_challenge_used", 409);
    await c.WORLD_ID_DB.prepare(
      "INSERT INTO world_identity_bindings (round, nullifier, wallet) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    ).bind(auth.challenge.round, nullifier, auth.wallet).run();
    const binding = await c.WORLD_ID_DB.prepare(
      "SELECT wallet FROM world_identity_bindings WHERE round = ? AND nullifier = ?",
    ).bind(auth.challenge.round, nullifier).first<{ wallet: string }>();
    if (binding?.wallet !== auth.wallet) return error("human_already_bound_to_another_wallet", 409);
    // A wallet is bound to exactly one verified human for the round.
    const own = await c.WORLD_ID_DB.prepare(
      "SELECT nullifier FROM world_identity_bindings WHERE round = ? AND wallet = ?",
    ).bind(auth.challenge.round, auth.wallet).first<{ nullifier: string }>();
    if (own?.nullifier !== nullifier) return error("wallet_already_bound_to_another_human", 409);
  } catch {
    return error("identity_storage_unavailable", 503);
  }
  return attestBinding(c, auth.challenge.round, auth.wallet, nullifier);
}

export async function attest(request: Request): Promise<Response> {
  const c = configured();
  if (!c) return error("identity_not_configured", 503);
  const data = await body(request);
  if (!data) return error("invalid_request", 400);
  try {
    const auth = await authenticate(c, data);
    if (!auth) return error("invalid_wallet_signature", 401);
    const binding = await c.WORLD_ID_DB.prepare(
      "SELECT nullifier FROM world_identity_bindings WHERE round = ? AND wallet = ?",
    ).bind(auth.challenge.round, auth.wallet).first<{ nullifier: string }>();
    if (!binding) return error("identity_proof_required", 403);
    return attestBinding(c, auth.challenge.round, auth.wallet, binding.nullifier);
  } catch {
    return error("identity_storage_unavailable", 503);
  }
}

async function attestBinding(c: IdentityConfig, round: string, wallet: string, nullifier: string): Promise<Response> {
  const db = c.WORLD_ID_DB;
  const pending = () => json({ verified: true, ready: false, round, wallet }, 202);
  if (!c.SUI_NETWORK || !c.SUI_RPC_URL || !c.SUI_IDENTITY_PRIVATE_KEY ||
      !c.SUI_IDENTITY_PACKAGE_ID || !c.SUI_IDENTITY_ROUNDS || !c.SUI_IDENTITY_COIN_TYPE) return pending();
  // Sandbox/staging proofs cannot authorize real-money activity on Sui mainnet.
  if (c.SUI_NETWORK === "mainnet" && c.WORLD_ID_ENVIRONMENT !== "production") return pending();
  let roundObjects: { competitionId: string; identityCapId: string };
  try {
    const rounds: unknown = JSON.parse(c.SUI_IDENTITY_ROUNDS);
    const objects = record(rounds) ? rounds[round] : null;
    if (!record(objects) || !text(objects.competitionId) || !addressPattern.test(objects.competitionId) ||
        !text(objects.identityCapId) || !addressPattern.test(objects.identityCapId)) return pending();
    roundObjects = { competitionId: objects.competitionId, identityCapId: objects.identityCapId };
  } catch {
    return pending();
  }
  const target = `${c.SUI_IDENTITY_PACKAGE_ID}::competition::Competition<${c.SUI_IDENTITY_COIN_TYPE}>`;
  const existing = await db.prepare(
    "SELECT status, attestation_digest, attestation_competition_id, attestation_network, attestation_target FROM world_identity_bindings WHERE round = ? AND nullifier = ? AND wallet = ?",
  ).bind(round, nullifier, wallet).first<{ status: string; attestation_digest: string | null;
    attestation_competition_id: string | null; attestation_network: string | null; attestation_target: string | null }>();
  if (existing?.status === "ready" && existing.attestation_digest &&
      existing.attestation_competition_id === roundObjects.competitionId &&
      existing.attestation_network === c.SUI_NETWORK && existing.attestation_target === target)
    return json({ verified: true, ready: true, round, wallet, attestationDigest: existing.attestation_digest });
  if (existing?.status === "ready") {
    await db.prepare(
      "UPDATE world_identity_bindings SET status = 'pending', attestation_digest = NULL, lease_until = 0 WHERE round = ? AND nullifier = ? AND wallet = ? AND status = 'ready'",
    ).bind(round, nullifier, wallet).run();
  }
  const now = Math.floor(Date.now() / 1000);
  const lease = await db.prepare(
    "UPDATE world_identity_bindings SET lease_until = ? WHERE round = ? AND nullifier = ? AND wallet = ? AND status = 'pending' AND lease_until < ?",
  ).bind(now + 90, round, nullifier, wallet, now).run();
  if (lease.meta.changes !== 1) return pending();
  try {
    const signer = Ed25519Keypair.fromSecretKey(c.SUI_IDENTITY_PRIVATE_KEY);
    const client = new SuiGrpcClient({ baseUrl: c.SUI_RPC_URL, network: c.SUI_NETWORK as "testnet" | "mainnet" | "devnet" | "localnet" });
    const tx = new Transaction();
    tx.moveCall({
      target: `${c.SUI_IDENTITY_PACKAGE_ID}::competition::attest_identity`,
      typeArguments: [c.SUI_IDENTITY_COIN_TYPE],
      arguments: [tx.object(roundObjects.competitionId), tx.object(roundObjects.identityCapId),
        tx.pure.address(wallet), tx.pure.vector("u8", await onchainNullifier(round, nullifier))],
    });
    tx.setSender(signer.toSuiAddress());
    tx.setGasBudget(100_000_000);
    const bytes = await tx.build({ client });
    const { signature } = await signer.signTransaction(bytes);
    const out = await client.executeTransaction({ transaction: bytes, signatures: [signature], include: { effects: true } });
    const result = out.Transaction ?? out.FailedTransaction;
    if (!result || !result.effects?.status.success) throw new Error("Identity attestation transaction failed");
    await client.waitForTransaction({ digest: result.digest });
    await db.prepare(
      "UPDATE world_identity_bindings SET status = 'ready', attestation_digest = ?, attestation_competition_id = ?, attestation_network = ?, attestation_target = ?, lease_until = 0 WHERE round = ? AND nullifier = ? AND wallet = ? AND status = 'pending'",
    ).bind(result.digest, roundObjects.competitionId, c.SUI_NETWORK, target, round, nullifier, wallet).run();
    return json({ verified: true, ready: true, round, wallet, attestationDigest: result.digest });
  } catch (cause) {
    console.error("World ID Sui attestation failed", cause);
    await db.prepare(
      "UPDATE world_identity_bindings SET lease_until = 0 WHERE round = ? AND nullifier = ? AND wallet = ? AND status = 'pending'",
    ).bind(round, nullifier, wallet).run();
    return pending();
  }
}
