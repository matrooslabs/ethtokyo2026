import { ConnectButton } from "@rainbow-me/rainbowkit";

const WalletConnectButton = () => (
  <ConnectButton.Custom>
    {({ account, mounted, openAccountModal, openConnectModal }) => {
      const connected = mounted && account;

      return (
        <button
          type="button"
          className="bg-primary text-primary-foreground hover:bg-primary/90 min-h-10 shrink-0 rounded-lg px-3 text-sm font-medium transition-colors"
          onClick={connected ? openAccountModal : openConnectModal}
          aria-label={connected ? `Wallet ${account.displayName}; manage connection` : "Connect wallet"}
        >
          {connected ? account.displayName : "Connect Wallet"}
        </button>
      );
    }}
  </ConnectButton.Custom>
);

export default WalletConnectButton;
