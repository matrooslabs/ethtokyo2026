import { createDAppKit, DAppKitProvider } from "@mysten/dapp-kit-react";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import ReactQueryProvider from "@/components/providers/reactQueryProvider";
import type { PropsWithChildren } from "react";

const network = import.meta.env.VITE_SUI_NETWORK === "mainnet" ? "mainnet" : "testnet";
const rpc =
  import.meta.env.VITE_SUI_GRPC_URL ||
  `https://fullnode.${network}.sui.io:443`;

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
  return <ReactQueryProvider><DAppKitProvider dAppKit={suiKit}>{children}</DAppKitProvider></ReactQueryProvider>;
}
