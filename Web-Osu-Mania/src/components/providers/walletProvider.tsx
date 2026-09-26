import "@rainbow-me/rainbowkit/styles.css";
import {
  RainbowKitProvider,
  darkTheme,
  lightTheme,
} from "@rainbow-me/rainbowkit";
import { walletConfig } from "@/lib/walletConfig";
import type { ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import ReactQueryProvider from "./reactQueryProvider";

const WalletProvider = ({ children }: { children: ReactNode }) => (
  <WagmiProvider config={walletConfig}>
    <ReactQueryProvider>
      <RainbowKitProvider
        theme={{
          lightMode: lightTheme({
            accentColor: "#b7e65c",
            accentColorForeground: "#191c16",
            borderRadius: "none",
            fontStack: "system",
          }),
          darkMode: darkTheme({
            accentColor: "#b7e65c",
            accentColorForeground: "#191c16",
            borderRadius: "none",
            fontStack: "system",
          }),
        }}
      >
        {children}
      </RainbowKitProvider>
    </ReactQueryProvider>
  </WagmiProvider>
);

export default WalletProvider;
