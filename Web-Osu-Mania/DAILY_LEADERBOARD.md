# versu! competition

The browser app uses a **Sui-native** GKR score registry and `mania_gkr::competition` Move vault. The old Sepolia payment/client routes are removed. Every purchase sends **exactly 1,000,000 base units of the configured six-decimal Coin<T>** to the vault and grants 3 plays to the World ID-verified wallet. `start_paid` burns one play atomically, creates an immutable hardware session, and never restores the credit on abort/reload/disconnect. Proof retry for a *completed captured* run is distinct from gameplay resume.

## Entry and payout

1. On desktop Chromium over HTTPS, choose the BridgeOS Vendor HID device. Browser HID status is not proof of physical input; the registered device's signed result and exact trace are checked by the sidecar and the Sui registry.
2. Connect a Sui wallet, complete IDKit v4 Proof of Human, and confirm the wallet ownership signature. A Cloudflare Worker verifies the World proof, stores one nullifier-to-wallet binding per UTC round in D1, then uses its Sui `IdentityCap` to register the round-specific commitment. Repeated purchases from the same verified wallet are allowed; another wallet for that person and round is rejected.
3. Purchase 3 plays with a Sui transaction. The Move vault owns the prize, not an operator account. Testnet deployments must label their coin **test USDC**, never real USDC.
4. Check the scorer and physical device again, preload the chart, then sign `start_paid` on Sui. The resulting Session belongs to that wallet/round/chart/device. One play is spent even if capture fails; no gameplay resume.
5. At game start the web client sends BridgeOS START immediately before audio; at completion it sends STOP and forwards the original 465-byte signed GET_RESULT and full GET_TRACE to the authenticated server proxy. The server verifies session/header/device/SHA chain/chart/SRS/signature, produces a GKR proof, and returns the original data plus the Sui Move submission plan. The wallet signs a transaction that calls `registry::submit_hardware` and `competition::record_score`; only a confirmed `PaidScoreRecorded` counts toward the leaderboard.
6. After the score deadline, anyone can send the entire pot to the highest verified Sui wallet. Ties keep the first recorded score. If there is no winner, or the winner remains unpaid past claim deadline, all buyers can reclaim their full purchased amount. Unused plays are not individually refunded when a winner exists.

## Browser configuration

See `.env.example`. Set `VITE_SUI_NETWORK`, `VITE_SUI_GRPC_URL`, `VITE_SUI_PACKAGE_ID`, `VITE_SUI_REGISTRY_ID`, `VITE_SUI_COMPETITION_ID`, `VITE_SUI_USDC_TYPE`, and a chart archive matching the registry's registered chart. The configured coin type must be a legitimate six-decimal USDC on mainnet or an **explicitly named test token** on testnet. The client fails closed if the vault/scoring service is not configured.

## Server secrets and state

Cloudflare Worker bindings: `WORLD_ID_DB` (real D1 ID; apply `migrations/0001_world_identity.sql`), `WORLD_ID_APP_ID`, `WORLD_ID_RP_ID`, `WORLD_ID_RP_SIGNING_KEY`, `WORLD_ID_ACTION`, `WORLD_ID_ENVIRONMENT`, `SUI_NETWORK`, `SUI_RPC_URL`, `SUI_IDENTITY_PRIVATE_KEY`, `SUI_IDENTITY_PACKAGE_ID`, `SUI_IDENTITY_COIN_TYPE`, `SUI_IDENTITY_ROUNDS` (JSON mapping UTC dates to competition/IdentityCap object IDs), `SUI_SCORING_ORIGIN`, `SUI_SCORING_API_TOKEN`. Keep private keys and bearer token in server-only secret storage. Do not use `VITE_` for them. Use a production World action if scanning with a real World App; staging is for the simulator and cannot authorize mainnet payments.

The Sui scoring server is `scoring/crates/prove-server-sui/`. It must be hosted behind an authenticated HTTPS origin reachable by the Worker; 127.0.0.1 works only with local development. Configure its SRS, package/registry IDs and persistent job directory. Do not expose its bearer token in browser assets. Its mode-3 calldata path supports up to roughly 7,000 HID events due to the Sui TraceUpload object limit; larger captures fail closed. The public development SRS currently in the Sui scoring repo has known toxic waste and **does not secure real prizes**. Provision a trusted SRS and an approved hardware signer before any real-money launch.

## Validation and deployment prerequisites

- `sui move test` in `scoring/gkr-scoring-sui/move/`: 91 passing tests after the vault and hardware-mode changes.
- `cargo test --locked -p mania-gkr-sui-prove-server` in `scoring/`: 2 passing tests. The bridge additionally exercised a consumed published testnet Session over gRPC and correctly rejected it; that is **not** a paid physical run.
- In `Web-Osu-Mania/`, use Node 22+: `npm run typecheck`, `npm test`, `npm run build`; open the running site for actual responsive and failure-state checks.
- A public prize demo still needs a real D1 binding and migrations, Portal app/RP/action and server signing key, funded Sui wallet and canonical test USDC, a newly deployed competition vault, an approved actual BridgeOS device, a trusted production SRS for real stakes, and successful wallet/World/physical proof transactions. None of those can be replaced with mocks and called a completed integration.
