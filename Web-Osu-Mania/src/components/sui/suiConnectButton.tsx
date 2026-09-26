import { useEffect, useState, type ComponentType } from "react";

// Mysten's UI package registers Lit custom elements and requires HTMLElement.
// Load it only after hydration; server rendering must not evaluate that module.
export default function SuiConnectButton() {
  const [Button, setButton] = useState<ComponentType | null>(null);
  useEffect(() => {
    let mounted = true;
    void import("@mysten/dapp-kit-react/ui").then(({ ConnectButton }) => {
      if (mounted) setButton(() => ConnectButton);
    });
    return () => { mounted = false; };
  }, []);
  return Button ? <Button /> : <span aria-label="Wallet connection loading">Loading wallet…</span>;
}
