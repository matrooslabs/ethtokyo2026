import { useCurrentAccount, useDAppKit } from "@mysten/dapp-kit-react";
import { IDKitRequestWidget, proofOfHuman, type IDKitResult, type RpContext } from "@worldcoin/idkit";
import { useEffect, useState } from "react";

type Challenge = {
  app_id: `app_${string}`;
  rp_id: string;
  action: string;
  environment: "production" | "staging" | "sandbox";
  round: string;
  signal: string;
  rp_context: RpContext;
  message: string;
};

type Verification = {
  verified: boolean;
  ready: boolean;
  round: string;
  wallet: string;
  attestationDigest?: string;
};

export default function WorldVerification({ onReady }: { onReady: (ready: boolean) => void }) {
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
  }, [account?.address, onReady]);

  async function begin() {
    if (!account) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/identity/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: account.address }),
      });
      const value = await response.json() as Challenge & { error?: string };
      if (!response.ok) throw new Error(value.error || "Could not start World ID verification.");
      setChallenge(value);
      setOpened(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function verify(proof: IDKitResult) {
    if (!account || !challenge || challenge.round !== new Date().toISOString().slice(0, 10)) {
      throw new Error("The round changed. Start verification again.");
    }
    const signature = await kit.signPersonalMessage({ message: new TextEncoder().encode(challenge.message) });
    const response = await fetch("/api/identity/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: account.address, nonce: challenge.rp_context.nonce, signature: signature.signature, proof }),
    });
    const result = await response.json() as Verification & { error?: string };
    if (!response.ok) throw new Error(result.error || "World ID verification was rejected.");
    if (!result.verified || result.wallet !== account.address || result.round !== challenge.round) {
      throw new Error("World ID verification did not match this wallet and round.");
    }
    if (!result.ready) {
      setPending(true);
      setError("Human verified. Sui attestation is pending; finalize it before buying plays.");
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
        body: JSON.stringify({ wallet: account.address }),
      });
      const fresh = await challengeResponse.json() as Challenge & { error?: string };
      if (!challengeResponse.ok) throw new Error(fresh.error || "Could not renew verification challenge.");
      const signed = await kit.signPersonalMessage({ message: new TextEncoder().encode(fresh.message) });
      const response = await fetch("/api/identity/attest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: account.address, nonce: fresh.rp_context.nonce, signature: signed.signature }),
      });
      const value = await response.json() as Verification & { error?: string };
      if (!response.ok) throw new Error(value.error || "Sui attestation failed.");
      if (!value.ready || value.wallet !== account.address || value.round !== fresh.round) {
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
      <h2>World ID</h2>
      <p>One person, one wallet per round.</p>
      {verified && boundWallet === account?.address ? (
        <p role="status">Verified.</p>
      ) : pending ? (
        <button type="button" className="arena-secondary" disabled={!account || busy} onClick={() => void finalize()}>
          {busy ? "Checking…" : "Finish verification"}
        </button>
      ) : (
        <button type="button" className="arena-secondary" disabled={!account || busy} onClick={() => void begin()}>
          {busy ? "Opening World ID…" : "Verify with World ID"}
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
