import { useCurrentAccount, useDAppKit } from "@mysten/dapp-kit-react";
import { IDKitRequestWidget, proofOfHuman, type IDKitResult, type RpContext } from "@worldcoin/idkit";
import { useEffect, useRef, useState } from "react";

type Challenge = {
  app_id: `app_${string}`;
  rp_id: string;
  action: string;
  environment: "production" | "staging" | "sandbox";
  challengeId: string;
  difficulty: "easy" | "hard";
  signal: string;
  rp_context: RpContext;
  message: string;
  challengeToken: string;
};

type Verification = {
  verified: boolean;
  ready: boolean;
  challengeId: string;
  difficulty: "easy" | "hard";
  wallet: string;
  attestationDigest?: string;
  attestationToken?: string;
};

export default function ClaimVerification({ challengeId, difficulty, onReady }: {
  challengeId: string;
  difficulty: "easy" | "hard";
  onReady: (ready: boolean) => void;
}) {
  const account = useCurrentAccount();
  const kit = useDAppKit();
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [opened, setOpened] = useState(false);
  const [attestationToken, setAttestationToken] = useState("");
  const selection = `${account?.address || ""}\0${challengeId}\0${difficulty}`;
  const ticketStorageKey = `versu:world-attestation:${account?.address || ""}:${challengeId}:${difficulty}`;
  const currentSelection = useRef({ key: selection, generation: 0 });
  if (currentSelection.current.key !== selection) {
    currentSelection.current.key = selection;
    currentSelection.current.generation += 1;
  }
  const [verified, setVerified] = useState(false);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [boundWallet, setBoundWallet] = useState("");

  useEffect(() => {
    setVerified(false);
    setPending(false);
    setAttestationToken("");
    setOpened(false);
    setChallenge(null);
    setBoundWallet("");
    setError("");
    setBusy(false);
    onReady(false);
    if (account?.address) {
      try {
        const saved = sessionStorage.getItem(ticketStorageKey);
        if (saved) { setAttestationToken(saved); setPending(true); }
      } catch { /* Wallet signature is still required to retry. */ }
    }
  }, [account?.address, challengeId, difficulty, onReady]);

  async function begin() {
    if (!account || currentSelection.current.key !== selection) return;
    const startedFor = currentSelection.current.generation;
    setBusy(true);
    setError("");
    setChallenge(null);
    try {
      const response = await fetch("/api/identity/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: account.address, challengeId, difficulty }),
      });
      const value = await response.json() as Challenge & { error?: string };
      if (currentSelection.current.generation !== startedFor) return;
      if (!response.ok) throw new Error(value.error || "Could not start World ID verification.");
      if (value.challengeId !== challengeId || value.difficulty !== difficulty) throw new Error("World ID challenge does not match the selected chart.");
      if (typeof value.challengeToken !== "string" || !value.challengeToken) throw new Error("World ID challenge ticket is missing. Start verification again.");
      setChallenge(value);
      setOpened(true);
    } catch (cause) {
      if (currentSelection.current.generation === startedFor) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (currentSelection.current.generation === startedFor) setBusy(false);
    }
  }

  async function verify(proof: IDKitResult) {
    const startedFor = currentSelection.current.generation;
    if (currentSelection.current.key !== selection || !account || !challenge || !challenge.challengeToken || challenge.challengeId !== challengeId || challenge.difficulty !== difficulty) {
      throw new Error("The selected challenge or chart changed. Start your claim again.");
    }
    const signature = await kit.signPersonalMessage({ message: new TextEncoder().encode(challenge.message) });
    if (currentSelection.current.generation !== startedFor) throw new Error("The selected wallet or chart changed. Start your claim again.");
    const response = await fetch("/api/identity/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: account.address, challengeId, difficulty, nonce: challenge.rp_context.nonce, challengeToken: challenge.challengeToken, signature: signature.signature, proof }),
    });
    const result = await response.json() as Verification & { error?: string };
    if (currentSelection.current.generation !== startedFor) throw new Error("The selected wallet or chart changed. Start your claim again.");
    if (!response.ok) {
      if ([400, 401, 403, 409, 410].includes(response.status)) {
        setChallenge(null);
        setOpened(false);
      }
      throw new Error(result.error || "World ID verification was rejected. Start verification again.");
    }
    if (!result.verified || result.wallet !== account.address || result.challengeId !== challengeId || result.difficulty !== difficulty) {
      throw new Error("World ID verification did not match this wallet and chart.");
    }
    if (!result.ready) {
      if (typeof result.attestationToken !== "string" || !result.attestationToken) throw new Error("Verified identity has no registration ticket. Start verification again.");
      setAttestationToken(result.attestationToken);
      try { sessionStorage.setItem(ticketStorageKey, result.attestationToken); } catch { /* Tab-only retry is optional. */ }
      setPending(true);
      setError("Identity verified. Sui registration is pending; select Finish verification to retry without repeating World ID.");
      return;
    }
    setAttestationToken("");
    try { sessionStorage.removeItem(ticketStorageKey); } catch { /* Storage may be disabled. */ }
    setPending(false);
    setBoundWallet(result.wallet);
    setVerified(true);
    onReady(true);
  }

  async function finalize() {
    if (!account || !pending || currentSelection.current.key !== selection) return;
    if (!attestationToken) {
      setPending(false);
      setError("Registration ticket is missing. Start World ID verification again.");
      return;
    }
    const startedFor = currentSelection.current.generation;
    const ticket = attestationToken;
    setBusy(true);
    setError("");
    try {
      const signed = await kit.signPersonalMessage({ message: new TextEncoder().encode(ticket) });
      if (currentSelection.current.generation !== startedFor) return;
      const response = await fetch("/api/identity/attest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: account.address, challengeId, difficulty, attestationToken: ticket, signature: signed.signature }),
      });
      const value = await response.json() as Verification & { error?: string };
      if (currentSelection.current.generation !== startedFor) return;
      if (!response.ok) {
        if ([400, 401, 403, 409, 410].includes(response.status)) {
          setPending(false);
          setAttestationToken("");
          try { sessionStorage.removeItem(ticketStorageKey); } catch { /* Storage may be disabled. */ }
          throw new Error(`${value.error || "Registration ticket was rejected."} Start World ID verification again if you are still eligible.`);
        }
        throw new Error(value.error || "Sui registration failed. Try Finish verification again.");
      }
      if (!value.verified || value.wallet !== account.address || value.challengeId !== challengeId || value.difficulty !== difficulty) {
        throw new Error("Sui registration did not match this wallet and chart.");
      }
      if (!value.ready) {
        if (typeof value.attestationToken !== "string" || !value.attestationToken) {
          setPending(false);
          setAttestationToken("");
          try { sessionStorage.removeItem(ticketStorageKey); } catch { /* Storage may be disabled. */ }
          throw new Error("Registration ticket is unavailable. Start World ID verification again.");
        }
        setAttestationToken(value.attestationToken);
        try { sessionStorage.setItem(ticketStorageKey, value.attestationToken); } catch { /* Tab-only retry is optional. */ }
        setError("Sui registration is not confirmed yet. Try Finish verification again.");
        return;
      }
      setPending(false);
      setAttestationToken("");
      try { sessionStorage.removeItem(ticketStorageKey); } catch { /* Storage may be disabled. */ }
      setBoundWallet(account.address);
      setVerified(true);
      onReady(true);
    } catch (cause) {
      if (currentSelection.current.generation === startedFor) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (currentSelection.current.generation === startedFor) setBusy(false);
    }
  }

  return (
    <section className="arena-identity-check" aria-label="World ID verification">
      <h2>Claim with World ID</h2>
      <p>Use your best-scoring wallet. One share per person across Easy and Hard.</p>
      {verified && boundWallet === account?.address ? (
        <p role="status">Claim registered.</p>
      ) : pending ? (
        <button type="button" className="arena-secondary" disabled={!account || busy} onClick={() => void finalize()}>
          {busy ? "Checking…" : "Finish verification"}
        </button>
      ) : (
        <button type="button" className="arena-secondary" disabled={!account || busy} onClick={() => void begin()}>
          {busy ? "Opening World ID…" : "Verify prize claim"}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {challenge && (
        <IDKitRequestWidget
          open={opened}
          onOpenChange={setOpened}
          app_id={challenge.app_id}
          action={challenge.action}
          environment={challenge.environment}
          rp_context={challenge.rp_context}
          allow_legacy_proofs={false}
          preset={proofOfHuman({ signal: challenge.signal })}
          language="en"
          handleVerify={(proof) => verify(proof).catch((cause: unknown) => {
            if (currentSelection.current.key === selection) setError(cause instanceof Error ? cause.message : String(cause));
            throw cause;
          })}
          onSuccess={() => setOpened(false)}
          onError={(code) => {
            if (currentSelection.current.key === selection) {
              setError((previous) => previous || `World ID verification failed (${code}). Check the World App and try again.`);
            }
          }}
        />
      )}
    </section>
  );
}
