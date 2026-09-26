import "@rainbow-me/rainbowkit/styles.css";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { walletConfig } from "@/lib/walletConfig";
import type { ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import ReactQueryProvider from "./reactQueryProvider";

const WalletProvider = ({ children }: { children: ReactNode }) => (
  <WagmiProvider config={walletConfig}>
    <ReactQueryProvider>
      <RainbowKitProvider
        theme={darkTheme({
          accentColor: "#FF66AA",
          accentColorForeground: "#190C13",
          borderRadius: "medium",
          fontStack: "system",
        })}
      >
        {children}
      </RainbowKitProvider>
    </ReactQueryProvider>
  </WagmiProvider>
);

export default WalletProvider;
