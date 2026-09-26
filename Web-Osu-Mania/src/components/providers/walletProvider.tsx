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
            accentColor: "#aa4823",
            accentColorForeground: "#faf6ed",
            borderRadius: "none",
            fontStack: "system",
          }),
          darkMode: darkTheme({
            accentColor: "#e99a73",
            accentColorForeground: "#29231e",
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
