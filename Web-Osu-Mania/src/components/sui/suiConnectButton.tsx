import { useCurrentAccount, useCurrentWallet, useDAppKit, useWallets } from "@mysten/dapp-kit-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useState } from "react";

export default function SuiConnectButton() {
  const account = useCurrentAccount();
  const currentWallet = useCurrentWallet();
  const wallets = useWallets();
  const kit = useDAppKit();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function connect(wallet: (typeof wallets)[number]) {
    setBusy(true);
    setError("");
    try {
      await kit.connectWallet({ wallet });
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect this Sui wallet.");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError("");
    try { await kit.disconnectWallet(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not disconnect this Sui wallet."); }
    finally { setBusy(false); }
  }

  return <>
    {account ? <div className="arena-connected-wallet" aria-label="Connected Sui wallet">
      {currentWallet?.icon && <img className="arena-connected-wallet-icon" src={currentWallet.icon} alt="" width="28" height="28" />}
      <span className="arena-wallet-identity"><strong>{currentWallet?.name || "Sui wallet"}</strong>
        <code>{account.address.slice(0, 8)}…{account.address.slice(-4)}</code></span>
      <button type="button" className="arena-wallet-disconnect" disabled={busy} onClick={() => void disconnect()}>Disconnect</button>
    </div> : <button type="button" className="arena-wallet-connect" onClick={() => { setError(""); setOpen(true); }}>Connect wallet</button>}
    {account && error && <p role="alert">{error}</p>}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="arena-wallet-dialog" aria-describedby={undefined}>
        <DialogTitle>Connect a wallet</DialogTitle>
        <div className="arena-wallet-options">
          {wallets.length ? wallets.map((wallet) => <button key={wallet.name} type="button" disabled={busy} onClick={() => void connect(wallet)}>
            {wallet.icon && <img src={wallet.icon} alt="" width="32" height="32" />}
            <span>{wallet.name}</span>
          </button>) : <p>No Sui wallet found. Install a compatible wallet to continue.</p>}
        </div>
        {error && <p role="alert">{error}</p>}
      </DialogContent>
    </Dialog>
  </>;
}
