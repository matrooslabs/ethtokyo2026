//! Typed contract boundary for the paid scoring workflow.
use alloy::{
    primitives::{Address, B256},
    providers::{DynProvider, Provider, ProviderBuilder},
    sol,
};
use anyhow::{ensure, Context, Result};
use mania_scoring_core::SessionHeader;
use serde::Deserialize;

sol! {
    #[derive(Debug)]
    struct Header {
        uint64 chainId; address verifier; bytes32 matchId; bytes32 sessionId;
        bytes32 challenge; address player; address device; bytes32 chartHash;
        bytes32 rulesetId; bytes32 bitstreamHash; bytes32 inputPolicyHash;
    }
    struct RegisteredChart { uint256[2] commitment; uint64 m; uint8 bits; uint64 components; uint64 maxEnd; bool registered; }
    struct Session { Header header; uint8 mode; uint64 expiresAt; bool consumed; uint32 score; uint32[6] judgements; }
    #[sol(rpc)]
    interface Registry {
        function PAID_SESSION_MODE() external view returns (uint8);
        function verifier() external view returns (address);
        function leaderboard() external view returns (address);
        function getChart(bytes32 chartHash) external view returns (RegisteredChart);
        function getSession(bytes32 id) external view returns (Session);
        function devices(address device) external view returns (bytes32 bitstreamHash, bool active);
    }
    #[sol(rpc)]
    interface Board {
        function registry() external view returns (address);
        function token() external view returns (address);
        function entries(bytes32 id) external view returns (bytes32 beatmapId, uint64 dayId, address payer, address player, bool scored);
        event EntryPaid(bytes32 indexed beatmapId, uint64 indexed dayId, bytes32 indexed sessionId, address payer, address player, address device, uint256 amount);
    }
    #[sol(rpc)]
    interface Verifier { function srsId() external view returns (bytes32); }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub chain_id: u64,
    pub srs_id: B256,
    pub token: Address,
    pub contracts: Contracts,
}
#[derive(Clone, Deserialize)]
pub struct Contracts {
    #[serde(rename = "DailyLeaderboard")]
    pub board: Address,
    #[serde(rename = "ManiaGkrRegistry")]
    pub registry: Address,
    #[serde(rename = "GkrScoreVerifier")]
    pub verifier: Address,
}

pub struct Chain {
    pub provider: DynProvider,
    pub manifest: Manifest,
    pub confirmations: u64,
}
impl Chain {
    pub fn new(rpc: &str, manifest: Manifest, confirmations: u64) -> Result<Self> {
        let provider = ProviderBuilder::new().connect_http(rpc.parse()?).erased();
        Ok(Self {
            provider,
            manifest,
            confirmations,
        })
    }
    pub async fn wiring(&self) -> Result<()> {
        ensure!(
            self.provider.get_chain_id().await? == self.manifest.chain_id,
            "RPC chain mismatch"
        );
        let c = &self.manifest.contracts;
        let registry = Registry::new(c.registry, &self.provider);
        let board = Board::new(c.board, &self.provider);
        ensure!(
            registry.PAID_SESSION_MODE().call().await? == 2
                && registry.verifier().call().await? == c.verifier
                && registry.leaderboard().call().await? == c.board
                && board.registry().call().await? == c.registry
                && board.token().call().await? == self.manifest.token
                && Verifier::new(c.verifier, &self.provider)
                    .srsId()
                    .call()
                    .await?
                    == self.manifest.srs_id,
            "deployment wiring/SRS mismatch"
        );
        Ok(())
    }
    pub async fn ready_chart(&self, chart: B256, device: Address) -> Result<()> {
        let registry = Registry::new(self.manifest.contracts.registry, &self.provider);
        ensure!(
            registry.getChart(chart).call().await?.registered,
            "chart is not registered"
        );
        ensure!(
            registry.devices(device).call().await?.active,
            "device is inactive"
        );
        Ok(())
    }
    pub async fn bound(
        &self,
        id: B256,
        chart: B256,
        player: Address,
        day: u64,
        entry_tx: B256,
    ) -> Result<Session> {
        let c = &self.manifest.contracts;
        let entry = Board::new(c.board, &self.provider)
            .entries(id)
            .call()
            .await?;
        let session = Registry::new(c.registry, &self.provider)
            .getSession(id)
            .call()
            .await?;
        let block = self
            .provider
            .get_block_by_number(alloy::eips::BlockNumberOrTag::Latest)
            .await?
            .context("latest block missing")?;
        ensure!(
            entry.payer != Address::ZERO
                && !entry.scored
                && !session.consumed
                && session.mode == 2
                && block.header.timestamp < session.expiresAt,
            "unknown, expired or consumed paid session"
        );
        ensure!(
            entry.beatmapId == chart
                && entry.player == player
                && entry.dayId == day
                && session.header.chartHash == chart
                && session.header.player == player
                && session.header.sessionId == id
                && session.header.chainId == self.manifest.chain_id
                && session.header.verifier == c.registry
                && session.header.inputPolicyHash
                    == B256::from(mania_gkr::scoring::session::input_policy_v2()),
            "paid session binding mismatch"
        );
        let device = Registry::new(c.registry, &self.provider)
            .devices(session.header.device)
            .call()
            .await?;
        ensure!(
            device.active && device.bitstreamHash == session.header.bitstreamHash,
            "device revoked or changed"
        );
        self.ready_chart(chart, session.header.device).await?;
        let receipt = self
            .provider
            .get_transaction_receipt(entry_tx)
            .await?
            .context("entry is not confirmed")?;
        ensure!(
            receipt.status()
                && block.header.number
                    >= receipt.block_number.context("entry block missing")? + self.confirmations
                        - 1,
            "entry is not confirmed"
        );
        ensure!(
            receipt
                .inner
                .logs()
                .iter()
                .any(|log| log.address() == c.board
                    && log.log_decode::<Board::EntryPaid>().is_ok_and(|event| event
                        .inner
                        .data
                        .sessionId
                        == id)),
            "entry receipt mismatch"
        );
        Ok(session)
    }
}

impl Header {
    pub fn core(&self) -> SessionHeader {
        SessionHeader {
            chain_id: self.chainId,
            verifier: self.verifier.into_array(),
            match_id: self.matchId.0,
            session_id: self.sessionId.0,
            challenge: self.challenge.0,
            player: self.player.into_array(),
            device: self.device.into_array(),
            chart_hash: self.chartHash.0,
            ruleset_id: self.rulesetId.0,
            bitstream_hash: self.bitstreamHash.0,
            input_policy_hash: self.inputPolicyHash.0,
        }
    }
}
