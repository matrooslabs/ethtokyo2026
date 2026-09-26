-- Apply to the WORLD_ID_DB D1 binding before enabling paid competition.
CREATE TABLE IF NOT EXISTS world_identity_challenges (
  nonce TEXT PRIMARY KEY,
  round TEXT NOT NULL,
  wallet TEXT NOT NULL,
  action TEXT NOT NULL,
  environment TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS world_identity_bindings (
  round TEXT NOT NULL,
  nullifier TEXT NOT NULL,
  wallet TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attestation_digest TEXT,
  attestation_competition_id TEXT,
  attestation_network TEXT,
  attestation_target TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (round, nullifier),
  UNIQUE (round, wallet)
);
CREATE INDEX IF NOT EXISTS world_identity_bindings_wallet ON world_identity_bindings(round, wallet);
