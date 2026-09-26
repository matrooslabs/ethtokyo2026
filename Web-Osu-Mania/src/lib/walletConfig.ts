import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { mainnet } from "wagmi/chains";

// Scaffold-ETH 2's public starter ID works for local development. Supply your
// own WalletConnect Cloud project ID for a production deployment.
export const walletConfig = getDefaultConfig({
  appName: "Web osu!mania",
  projectId:
    import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ||
    "3a8170812b534d0ff9d794f19a901d64",
  chains: [mainnet],
  ssr: true,
});
