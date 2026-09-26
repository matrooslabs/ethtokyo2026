import { useCurrentAccount, useDAppKit } from "@mysten/dapp-kit-react";
import { IDKitRequestWidget, proofOfHuman, type IDKitResult, type RpContext } from "@worldcoin/idkit";
import { useEffect, useState } from "react";

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
};

type Verification = {
  verified: boolean;
  ready: boolean;
  challengeId: string;
  difficulty: "easy" | "hard";
  wallet: string;
  attestationDigest?: string;
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
  const [verified, setVerified] = useState(false);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [boundWallet, setBoundWallet] = useState("");

  useEffect(() => {
    setVerified(false);
    setPending(false);
    setOpened(false);
    setChallenge(null);
    setBoundWallet("");
    onReady(false);
  }, [account?.address, challengeId, difficulty, onReady]);

  async function begin() {
    if (!account) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/identity/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: account.address, challengeId, difficulty }),
      });
      const value = await response.json() as Challenge & { error?: string };
      if (!response.ok) throw new Error(value.error || "Could not start World ID verification.");
      if (value.challengeId !== challengeId || value.difficulty !== difficulty) throw new Error("World ID challenge does not match the selected chart.");
      setChallenge(value);
      setOpened(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function verify(proof: IDKitResult) {
    if (!account || !challenge || challenge.challengeId !== challengeId || challenge.difficulty !== difficulty) {
      throw new Error("The selected challenge or chart changed. Start your claim again.");
    }
    const signature = await kit.signPersonalMessage({ message: new TextEncoder().encode(challenge.message) });
    const response = await fetch("/api/identity/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: account.address, challengeId, difficulty, nonce: challenge.rp_context.nonce, signature: signature.signature, proof }),
    });
    const result = await response.json() as Verification & { error?: string };
    if (!response.ok) throw new Error(result.error || "World ID verification was rejected.");
    if (!result.verified || result.wallet !== account.address || result.challengeId !== challengeId || result.difficulty !== difficulty) {
      throw new Error("World ID verification did not match this wallet and chart.");
    }
    if (!result.ready) {
      setPending(true);
      setError("Identity verified. Sui claim registration is pending.");
      return;
    }
    setPending(false);
    setBoundWallet(result.wallet);
    setVerified(true);
    onReady(true);
  }

  async function finalize() {
    if (!account) return;
    setBusy(true);
    setError("");
    try {
      const challengeResponse = await fetch("/api/identity/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: account.address, challengeId, difficulty }),
      });
      const fresh = await challengeResponse.json() as Challenge & { error?: string };
      if (!challengeResponse.ok) throw new Error(fresh.error || "Could not renew verification challenge.");
      if (fresh.challengeId !== challengeId || fresh.difficulty !== difficulty) throw new Error("Renewed World ID challenge does not match the selected chart.");
      const signed = await kit.signPersonalMessage({ message: new TextEncoder().encode(fresh.message) });
      const response = await fetch("/api/identity/attest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: account.address, challengeId, difficulty, nonce: fresh.rp_context.nonce, signature: signed.signature }),
      });
      const value = await response.json() as Verification & { error?: string };
      if (!response.ok) throw new Error(value.error || "Sui attestation failed.");
      if (!value.ready || value.wallet !== account.address || value.challengeId !== challengeId || value.difficulty !== difficulty) {
        throw new Error("Sui attestation is not confirmed yet. Try again.");
      }
      setPending(false);
      setBoundWallet(account.address);
      setVerified(true);
      onReady(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
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
          handleVerify={verify}
          onSuccess={() => setOpened(false)}
          onError={() => setError("World ID verification failed. Check the World App and try again.")}
        />
      )}
    </section>
  );
}
