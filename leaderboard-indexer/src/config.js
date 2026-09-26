import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function integer(name, value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!/^(0|[1-9][0-9]*)$/.test(value ?? '') || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum)
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return Number(value);
}
export function configFromEnv(env = process.env) {
  if (!env.RPC_URL) throw new Error('RPC_URL is required');
  const rpc = new URL(env.RPC_URL);
  if (!['http:', 'https:'].includes(rpc.protocol)) throw new Error('RPC_URL must use HTTP(S)');
  if (!/^0x[0-9a-fA-F]{40}$/.test(env.LEADERBOARD_ADDRESS ?? '') || /^0x0{40}$/i.test(env.LEADERBOARD_ADDRESS))
    throw new Error('LEADERBOARD_ADDRESS must be a nonzero 20-byte address');
  const metadata = env.METADATA_PATH ? JSON.parse(readFileSync(env.METADATA_PATH, 'utf8')) : {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Metadata must be an object keyed by chart hash');
  const normalizedMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid chart metadata');
    normalizedMetadata[key.toLowerCase()] = value;
  }
  return {
    rpcUrl: env.RPC_URL,
    identity: { chainId: String(integer('CHAIN_ID', env.CHAIN_ID, 1)), address: env.LEADERBOARD_ADDRESS.toLowerCase(),
      deploymentBlock: String(integer('DEPLOYMENT_BLOCK', env.DEPLOYMENT_BLOCK)) },
    confirmations: integer('CONFIRMATIONS', env.CONFIRMATIONS ?? '2', 0, 10000),
    batchSize: integer('BATCH_SIZE', env.BATCH_SIZE ?? '100', 1, 1000),
    pollMs: integer('POLL_MS', env.POLL_MS ?? '5000', 100, 3600000),
    port: integer('PORT', env.PORT ?? '8787', 1, 65535), host: env.HOST ?? '127.0.0.1',
    dbPath: resolve(env.DB_PATH ?? 'data/leaderboard.sqlite'), metadata: normalizedMetadata,
    corsOrigin: env.CORS_ORIGIN ?? '*',
  };
}
