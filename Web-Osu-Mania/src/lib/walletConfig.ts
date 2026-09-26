import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { sepolia, foundry } from "wagmi/chains";
import { http } from "wagmi";
import { injectedWallet, walletConnectWallet } from "@rainbow-me/rainbowkit/wallets";

export const competitionChain = import.meta.env.DEV && import.meta.env.VITE_DEVELOPMENT_CHAIN_ID === "31337" ? foundry : sepolia;
export const walletConnectConfigured = !!import.meta.env.VITE_WALLETCONNECT_PROJECT_ID;
const transports = {
  [sepolia.id]: http(import.meta.env.VITE_SEPOLIA_RPC_URL || undefined),
  [foundry.id]: http(import.meta.env.VITE_LOCAL_RPC_URL || "http://127.0.0.1:8545"),
};
// Extensions work without a hosted relay. Phone QR requires the operator's project ID.
export const walletConfig = getDefaultConfig({
  appName: "Web osu!mania",
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "unused-injected-only",
  wallets: [{ groupName: "Wallets", wallets: walletConnectConfigured ? [injectedWallet, walletConnectWallet] : [injectedWallet] }],
  chains: [competitionChain],
  transports,
  ssr: true,
});
