-- One World-verified human and wallet may register ONE claim per shared Challenge,
-- regardless of which difficulty's prize slice they choose. Apply to a NEW D1 database
-- before enabling claims. Existing date-keyed tables require an explicit data migration;
-- CREATE IF NOT EXISTS will not alter them, and server queries fail closed (503).
CREATE TABLE IF NOT EXISTS world_identity_challenges (
  nonce TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  difficulty TEXT NOT NULL CHECK (difficulty IN ('easy', 'hard')),
  wallet TEXT NOT NULL,
  action TEXT NOT NULL,
  environment TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS world_identity_bindings (
  challenge_id TEXT NOT NULL,
  difficulty TEXT NOT NULL CHECK (difficulty IN ('easy', 'hard')),
  nullifier TEXT NOT NULL,
  wallet TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attestation_digest TEXT,
  attestation_challenge_id TEXT,
  attestation_network TEXT,
  attestation_target TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (challenge_id, nullifier),
  UNIQUE (challenge_id, wallet)
);
CREATE INDEX IF NOT EXISTS world_identity_bindings_wallet ON world_identity_bindings(challenge_id, wallet);
