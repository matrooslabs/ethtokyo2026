// Server-only claim configuration: WORLD_ID_DB (D1; apply migrations/0001_world_identity.sql),
// WORLD_ID_APP_ID, WORLD_ID_RP_ID, WORLD_ID_RP_SIGNING_KEY (secret),
// WORLD_ID_ACTION=versu-prize-claim (Portal-registered), WORLD_ID_ENVIRONMENT.
// Claim attestor: SUI_NETWORK, SUI_RPC_URL, SUI_IDENTITY_PRIVATE_KEY (sui1... Ed25519
// secret owning IdentityCap), SUI_IDENTITY_PACKAGE_ID, SUI_IDENTITY_COIN_TYPE,
// SUI_IDENTITY_CHALLENGES (JSON {"0x<challengeId>":{"identityCapId":"0x..."}}).
// VITE_SUI_EASY_CHART_HASH and VITE_SUI_HARD_CHART_HASH must match the onchain charts.
// No World ID challenge is required for purchasing credits or starting a paid run.
import { bcs } from "@mysten/sui/bcs";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, fromHex, normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
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
  SUI_IDENTITY_CHALLENGES?: string;
  VITE_SUI_EASY_CHART_HASH?: string;
  VITE_SUI_REGISTRY_ID?: string;
  VITE_SUI_HARD_CHART_HASH?: string;
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
// World nullifiers are RP-scoped private identifiers; only publish a challenge-specific commitment.
async function onchainNullifier(challengeId: string, nullifier: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const domain = encoder.encode(`versu:world-id:challenge:v1:${challengeId}:`);
  const commitment = new Uint8Array(domain.length + 32);
  commitment.set(domain);
  const hex = nullifier.slice(2);
  for (let index = 0; index < 32; index++) {
    commitment[domain.length + index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", commitment));
}
function configured(): IdentityConfig | null {
  const c = env as unknown as IdentityEnv;
  if (!c.WORLD_ID_DB || !/^app_[a-zA-Z0-9_-]+$/.test(c.WORLD_ID_APP_ID ?? "") ||
      !/^rp_[a-zA-Z0-9_-]+$/.test(c.WORLD_ID_RP_ID ?? "") ||
      !/^(0x)?[a-fA-F0-9]{64}$/.test(c.WORLD_ID_RP_SIGNING_KEY ?? "") ||
      c.WORLD_ID_ACTION !== "versu-prize-claim" ||
      !["production", "staging", "sandbox"].includes(c.WORLD_ID_ENVIRONMENT ?? "")) {
    return null;
  }
  return c as IdentityConfig;
}
type ChallengeObjects = { challengeId: string; identityCapId: string; easyChartHash: string; hardChartHash: string };
function deployedChallenge(c: IdentityConfig, challengeId: string): ChallengeObjects | null {
  try {
    const challenges: unknown = JSON.parse(c.SUI_IDENTITY_CHALLENGES ?? "");
    if (!record(challenges)) return null;
    const mapping = challenges[challengeId];
    if (!record(mapping) || !text(mapping.identityCapId) ||
        !addressPattern.test(mapping.identityCapId)) return null;
    const easyChartHash = c.VITE_SUI_EASY_CHART_HASH ?? import.meta.env.VITE_SUI_EASY_CHART_HASH;
    const hardChartHash = c.VITE_SUI_HARD_CHART_HASH ?? import.meta.env.VITE_SUI_HARD_CHART_HASH;
    if (!/^0x[0-9a-fA-F]{64}$/.test(easyChartHash ?? "") ||
        !/^0x[0-9a-fA-F]{64}$/.test(hardChartHash ?? "") ||
        easyChartHash.toLowerCase() === hardChartHash.toLowerCase()) return null;
    return { challengeId, identityCapId: normalizeSuiAddress(mapping.identityCapId),
      easyChartHash: easyChartHash.toLowerCase(), hardChartHash: hardChartHash.toLowerCase() };
  } catch {
    return null;
  }
}

function chainBytes(value: unknown): Uint8Array | null {
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255))
    return Uint8Array.from(value);
  if (!text(value)) return null;
  try { return value.startsWith("0x") ? fromHex(value.slice(2)) : fromBase64(value); }
  catch { return null; }
}
function chainHash(value: unknown): string | null {
  const bytes = chainBytes(value);
  return bytes?.length === 32 ? `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}` : null;
}

// The claimant chooses their best-ranked wallet BEFORE proving humanity: another
// wallet controlled by the same person cannot claim this challenge after registration.
async function claimEligibility(c: IdentityConfig, challengeId: string, difficulty: "easy" | "hard", wallet: string): Promise<Response | null> {
  if (!c.SUI_NETWORK || !c.SUI_RPC_URL || !c.SUI_IDENTITY_PACKAGE_ID || !c.SUI_IDENTITY_COIN_TYPE ||
      !c.SUI_IDENTITY_CHALLENGES ||
      !walletAddress(c.VITE_SUI_REGISTRY_ID ?? import.meta.env.VITE_SUI_REGISTRY_ID) ||
      !/^0x[0-9a-fA-F]{64}$/.test(c.VITE_SUI_EASY_CHART_HASH ?? import.meta.env.VITE_SUI_EASY_CHART_HASH ?? "") ||
      !/^0x[0-9a-fA-F]{64}$/.test(c.VITE_SUI_HARD_CHART_HASH ?? import.meta.env.VITE_SUI_HARD_CHART_HASH ?? ""))
    return error("claim_chain_not_configured", 503);
  const objects = deployedChallenge(c, challengeId);
  if (!objects) return error("claim_round_unavailable", 409);
  try {
    const client = new SuiGrpcClient({ baseUrl: c.SUI_RPC_URL,
      network: c.SUI_NETWORK as "testnet" | "mainnet" | "devnet" | "localnet" });
    const [{ object: challenge }, { object: clock }] = await Promise.all([
      client.getObject({ objectId: challengeId, include: { json: true } }),
      client.getObject({ objectId: "0x6", include: { json: true } }),
    ]);
    const expected = `${normalizeSuiAddress(c.SUI_IDENTITY_PACKAGE_ID)}::competition::Challenge<${c.SUI_IDENTITY_COIN_TYPE}>`;
    const expectedRegistry = walletAddress(c.VITE_SUI_REGISTRY_ID ?? import.meta.env.VITE_SUI_REGISTRY_ID);
    if (!expectedRegistry || normalizeStructTag(challenge.type) !== normalizeStructTag(expected) ||
        !challenge.json || !clock.json || walletAddress(challenge.json.registry) !== expectedRegistry)
      return error("claim_round_mismatch", 409);
    const encodedDate = challenge.json.round_date;
    const dateBytes = chainBytes(encodedDate);
    const date = text(encodedDate) && /^\d{4}-\d{2}-\d{2}$/.test(encodedDate) ? encodedDate :
      dateBytes && new TextDecoder("utf-8", { fatal: true }).decode(dateBytes);
    const parsedDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
    if (!Number.isFinite(parsedDate) || new Date(parsedDate).toISOString().slice(0, 10) !== date ||
        chainHash(challenge.json.easy_chart_hash) !== objects.easyChartHash ||
        chainHash(challenge.json.hard_chart_hash) !== objects.hardChartHash)
      return error("claim_round_mismatch", 409);
    const roundId = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`versu:${date}`)));
    const chainRoundId = chainBytes(challenge.json.round_id);
    if (!chainRoundId || chainRoundId.length !== 32 || !chainRoundId.every((byte, index) => byte === roundId[index]))
      return error("claim_round_mismatch", 409);
    const startedAt = challenge.json.started_at_ms;
    const scoreCutoff = challenge.json.score_deadline_ms;
    const claimWindow = challenge.json.claim_window_ms;
    const claimCutoff = challenge.json.claim_deadline_ms;
    const clockTime = clock.json.timestamp_ms;
    if (![startedAt, scoreCutoff, claimWindow, claimCutoff, clockTime].every((value) =>
        (typeof value === "string" && /^\d+$/.test(value)) || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)))
      return error("claim_chain_unavailable", 503);
    const start = BigInt(startedAt as string | number);
    const scoredAt = BigInt(scoreCutoff as string | number);
    const claimBy = BigInt(claimCutoff as string | number);
    const now = BigInt(clockTime as string | number);
    if (start === 0n || scoredAt !== start + 21_600_000n ||
        BigInt(claimWindow as string | number) === 0n || claimBy !== scoredAt + BigInt(claimWindow as string | number))
      return error("claim_round_mismatch", 409);
    if (now < scoredAt || now >= claimBy) return error("claim_window_closed", 409);
    const buyers = challenge.json.buyers;
    if (!record(buyers) || !text(buyers.id)) return error("claim_chain_unavailable", 503);
    let fieldId: string;
    try {
      const { dynamicField } = await client.getDynamicField({
        parentId: buyers.id, name: { type: "address", bcs: bcs.Address.serialize(wallet).toBytes() },
      });
      fieldId = dynamicField.fieldId;
    } catch {
      return error("claim_wallet_unscored", 403);
    }
    const { object: buyerField } = await client.getObject({ objectId: fieldId, include: { json: true } });
    const buyer = buyerField.json?.value;
    if (!record(buyer)) return error("claim_chain_unavailable", 503);
    const option = buyer[difficulty === "easy" ? "best_easy" : "best_hard"];
    const vec = record(option) ? option.vec : option;
    const best = Array.isArray(vec) ? vec.length === 1 ? vec[0] : null : vec;
    const score = record(best) ? best.score : null;
    if (!((typeof score === "string" && /^\d+$/.test(score)) ||
      (typeof score === "number" && Number.isSafeInteger(score) && score >= 0)))
      return error("claim_wallet_unscored", 403);
    return null;
  } catch {
    return error("claim_chain_unavailable", 503);
  }
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
  const challengeId = walletAddress(data?.challengeId);
  const difficulty = data?.difficulty;
  if (!challengeId || (difficulty !== "easy" && difficulty !== "hard")) return error("invalid_claim_challenge", 400);
  const eligibility = await claimEligibility(c, challengeId, difficulty, wallet);
  if (eligibility) return eligibility;
  const signal = `${challengeId}:${difficulty}:${wallet}`;
  const rp = signRequest({ signingKeyHex: c.WORLD_ID_RP_SIGNING_KEY, action: c.WORLD_ID_ACTION });
  const message = `versu prize claim\nchallenge: ${challengeId}\ndifficulty: ${difficulty}\nwallet: ${wallet}\nnonce: ${rp.nonce}\naction: ${c.WORLD_ID_ACTION}\n`;
  const expires = rp.expiresAt;
  try {
    await c.WORLD_ID_DB.prepare(
      "INSERT INTO world_identity_challenges (nonce, challenge_id, difficulty, wallet, action, environment, message, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(rp.nonce, challengeId, difficulty, wallet, c.WORLD_ID_ACTION, c.WORLD_ID_ENVIRONMENT, message, expires).run();
  } catch {
    return error("identity_storage_unavailable", 503);
  }
  return json({ app_id: c.WORLD_ID_APP_ID, rp_id: c.WORLD_ID_RP_ID, action: c.WORLD_ID_ACTION,
    environment: c.WORLD_ID_ENVIRONMENT, challengeId, difficulty, signal, message,
    rp_context: { rp_id: c.WORLD_ID_RP_ID, nonce: rp.nonce, created_at: rp.createdAt,
      expires_at: rp.expiresAt, signature: rp.sig } });
}

type Challenge = { challenge_id: string; difficulty: "easy" | "hard"; wallet: string; action: string; environment: string;
  message: string; expires_at: number; consumed: number };
type AuthenticatedWallet = { wallet: string; nonce: string; challenge: Challenge };
async function authenticate(c: IdentityConfig, data: Record<string, unknown>): Promise<AuthenticatedWallet | null> {
  const wallet = walletAddress(data.wallet);
  const nonce = data.nonce;
  if (!wallet || !text(nonce) || !noncePattern.test(nonce) || !text(data.signature)) return null;
  const challenge = await c.WORLD_ID_DB.prepare(
    "SELECT challenge_id, difficulty, wallet, action, environment, message, expires_at, consumed FROM world_identity_challenges WHERE nonce = ?",
  ).bind(nonce).first<Challenge>();
  if (!challenge || challenge.wallet !== wallet ||
      challenge.challenge_id !== walletAddress(data.challengeId) || challenge.difficulty !== data.difficulty ||
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
    BigInt(response.signal_hash) === BigInt(hashSignal(`${challenge.challenge_id}:${challenge.difficulty}:${challenge.wallet}`)) &&
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
  const eligibility = await claimEligibility(c, auth.challenge.challenge_id, auth.challenge.difficulty, auth.wallet);
  if (eligibility) return eligibility;
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
      "INSERT INTO world_identity_bindings (challenge_id, difficulty, nullifier, wallet) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
    ).bind(auth.challenge.challenge_id, auth.challenge.difficulty, nullifier, auth.wallet).run();
    const binding = await c.WORLD_ID_DB.prepare(
      "SELECT wallet, difficulty FROM world_identity_bindings WHERE challenge_id = ? AND nullifier = ?",
    ).bind(auth.challenge.challenge_id, nullifier).first<{ wallet: string; difficulty: string }>();
    if (binding?.wallet !== auth.wallet) return error("human_already_bound_to_another_wallet", 409);
    if (binding.difficulty !== auth.challenge.difficulty) return error("human_already_claimed_this_challenge", 409);
    // One wallet and one World-verified human per Challenge, across both difficulty prize slices.
    const own = await c.WORLD_ID_DB.prepare(
      "SELECT nullifier, difficulty FROM world_identity_bindings WHERE challenge_id = ? AND wallet = ?",
    ).bind(auth.challenge.challenge_id, auth.wallet).first<{ nullifier: string; difficulty: string }>();
    if (own?.nullifier !== nullifier) return error("wallet_already_bound_to_another_human", 409);
    if (own.difficulty !== auth.challenge.difficulty) return error("wallet_already_claimed_this_challenge", 409);
  } catch {
    return error("identity_storage_unavailable", 503);
  }
  return attestBinding(c, auth.challenge.challenge_id, auth.challenge.difficulty, auth.wallet, nullifier);
}

export async function attest(request: Request): Promise<Response> {
  const c = configured();
  if (!c) return error("identity_not_configured", 503);
  const data = await body(request);
  if (!data) return error("invalid_request", 400);
  try {
    const auth = await authenticate(c, data);
    if (!auth) return error("invalid_wallet_signature", 401);
    const eligibility = await claimEligibility(c, auth.challenge.challenge_id, auth.challenge.difficulty, auth.wallet);
    if (eligibility) return eligibility;
    const binding = await c.WORLD_ID_DB.prepare(
      "SELECT nullifier, difficulty FROM world_identity_bindings WHERE challenge_id = ? AND wallet = ?",
    ).bind(auth.challenge.challenge_id, auth.wallet).first<{ nullifier: string; difficulty: string }>();
    if (!binding) return error("identity_proof_required", 403);
    if (binding.difficulty !== auth.challenge.difficulty) return error("wallet_already_claimed_this_challenge", 409);
    return attestBinding(c, auth.challenge.challenge_id, auth.challenge.difficulty, auth.wallet, binding.nullifier);
  } catch {
    return error("identity_storage_unavailable", 503);
  }
}

async function attestBinding(c: IdentityConfig, challengeId: string, difficulty: "easy" | "hard", wallet: string, nullifier: string): Promise<Response> {
  const db = c.WORLD_ID_DB;
  const pending = () => json({ verified: true, ready: false, challengeId, difficulty, wallet }, 202);
  if (!c.SUI_NETWORK || !c.SUI_RPC_URL || !c.SUI_IDENTITY_PRIVATE_KEY ||
      !c.SUI_IDENTITY_PACKAGE_ID || !c.SUI_IDENTITY_CHALLENGES || !c.SUI_IDENTITY_COIN_TYPE)
    return error("claim_attestor_not_configured", 503);
  // Sandbox/staging proofs cannot authorize real-money activity on Sui mainnet.
  if (c.SUI_NETWORK === "mainnet" && c.WORLD_ID_ENVIRONMENT !== "production")
    return error("identity_environment_mismatch", 503);
  const objects = deployedChallenge(c, challengeId);
  if (!objects) return error("claim_round_unavailable", 409);
  const target = `${normalizeSuiAddress(c.SUI_IDENTITY_PACKAGE_ID)}::competition::Challenge<${c.SUI_IDENTITY_COIN_TYPE}>`;
  const existing = await db.prepare(
    "SELECT status, attestation_digest, attestation_challenge_id, attestation_network, attestation_target FROM world_identity_bindings WHERE challenge_id = ? AND difficulty = ? AND nullifier = ? AND wallet = ?",
  ).bind(challengeId, difficulty, nullifier, wallet).first<{ status: string; attestation_digest: string | null;
    attestation_challenge_id: string | null; attestation_network: string | null; attestation_target: string | null }>();
  if (existing?.status === "ready" && existing.attestation_digest &&
      existing.attestation_challenge_id === challengeId &&
      existing.attestation_network === c.SUI_NETWORK && existing.attestation_target === target)
    return json({ verified: true, ready: true, challengeId, difficulty, wallet, attestationDigest: existing.attestation_digest });
  if (existing?.status === "ready") return error("claim_attestation_mismatch", 409);
  const now = Math.floor(Date.now() / 1000);
  const lease = await db.prepare(
    "UPDATE world_identity_bindings SET lease_until = ? WHERE challenge_id = ? AND difficulty = ? AND nullifier = ? AND wallet = ? AND status = 'pending' AND lease_until < ?",
  ).bind(now + 90, challengeId, difficulty, nullifier, wallet, now).run();
  if (lease.meta.changes !== 1) return pending();
  try {
    const signer = Ed25519Keypair.fromSecretKey(c.SUI_IDENTITY_PRIVATE_KEY);
    const client = new SuiGrpcClient({ baseUrl: c.SUI_RPC_URL, network: c.SUI_NETWORK as "testnet" | "mainnet" | "devnet" | "localnet" });
    const tx = new Transaction();
    tx.moveCall({
      target: `${c.SUI_IDENTITY_PACKAGE_ID}::competition::register_claim`,
      typeArguments: [c.SUI_IDENTITY_COIN_TYPE],
      arguments: [tx.object(challengeId), tx.object(objects.identityCapId), tx.pure.address(wallet),
        tx.pure.u8(difficulty === "easy" ? 0 : 1),
        tx.pure.vector("u8", await onchainNullifier(challengeId, nullifier)), tx.object("0x6")],
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
      "UPDATE world_identity_bindings SET status = 'ready', attestation_digest = ?, attestation_challenge_id = ?, attestation_network = ?, attestation_target = ?, lease_until = 0 WHERE challenge_id = ? AND difficulty = ? AND nullifier = ? AND wallet = ? AND status = 'pending'",
    ).bind(result.digest, challengeId, c.SUI_NETWORK, target, challengeId, difficulty, nullifier, wallet).run();
    return json({ verified: true, ready: true, challengeId, difficulty, wallet, attestationDigest: result.digest });
  } catch (cause) {
    console.error("World ID Sui attestation failed", cause);
    await db.prepare(
      "UPDATE world_identity_bindings SET lease_until = 0 WHERE challenge_id = ? AND difficulty = ? AND nullifier = ? AND wallet = ? AND status = 'pending'",
    ).bind(challengeId, difficulty, nullifier, wallet).run();
    return pending();
  }
}
