import "@rainbow-me/rainbowkit/styles.css";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { walletConfig } from "@/lib/walletConfig";
import type { ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import ReactQueryProvider from "./reactQueryProvider";

const WalletProvider = ({ children }: { children: ReactNode }) => (
  <WagmiProvider config={walletConfig}>
    <ReactQueryProvider>
      <RainbowKitProvider>{children}</RainbowKitProvider>
    </ReactQueryProvider>
  </WagmiProvider>
);

export default WalletProvider;
