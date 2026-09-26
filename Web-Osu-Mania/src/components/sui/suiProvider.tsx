import { createDAppKit, DAppKitProvider } from "@mysten/dapp-kit-react";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { useEffect } from "react";
import ReactQueryProvider from "@/components/providers/reactQueryProvider";
import type { PropsWithChildren } from "react";

const network = import.meta.env.VITE_SUI_NETWORK === "mainnet" ? "mainnet" : "testnet";
const rpc =
  import.meta.env.VITE_SUI_GRPC_URL ||
  `https://fullnode.${network}.sui.io:443`;

export const phoneQrConfigured = !!import.meta.env.VITE_WALLETCONNECT_PROJECT_ID;
let walletConnectRegistered = false;

export const suiKit = createDAppKit({
  networks: [network],
  createClient: () => new SuiGrpcClient({ network, baseUrl: rpc }),
});

declare module "@mysten/dapp-kit-react" {
  interface Register {
    dAppKit: typeof suiKit;
  }
}

export default function SuiProvider({ children }: PropsWithChildren) {
  useEffect(() => {
    if (!phoneQrConfigured || walletConnectRegistered) return;
    walletConnectRegistered = true;
    void import("@mysten/walletconnect-wallet").then(({ registerWalletConnectWallet }) => {
      registerWalletConnectWallet({
        projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID,
        getClient: (chain) => new SuiGrpcClient({
          network: chain,
          baseUrl: chain === network ? rpc : chain === "localnet" ? "http://127.0.0.1:9000" : `https://fullnode.${chain}.sui.io:443`,
        }),
        metadata: {
          id: "versu-walletconnect",
          walletName: "WalletConnect phone",
          icon: `${window.location.origin}/versu-logo.png`,
          enabled: true,
        },
      });
    }).catch(() => { walletConnectRegistered = false; });
  }, []);
  return <ReactQueryProvider><DAppKitProvider dAppKit={suiKit}>{children}</DAppKitProvider></ReactQueryProvider>;
}
