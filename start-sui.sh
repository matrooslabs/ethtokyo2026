#!/usr/bin/env bash
# Start the local web app and authenticated Sui hardware prover. No chain writes.
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

case "${1:-}" in
  --help|-h)
    cat <<'HELP'
Usage: ./start-sui.sh [--check]

Starts the Sui testnet prover and web app. Ctrl-C stops both.
--check starts both, verifies the scoring proxy, then stops them.

Optional environment variables:
  WEB_PORT=3000                   Local web port
  PROVER_PORT=8092                Local prover port
  SUI_DEPLOYMENT_FILE=<json>      Deployment manifest or public deployment receipt
  SUI_SRS_FILE=<bin>              Existing matching Sui BLS12-381 SRS
  PROVER_API_TOKEN=<secret>       Otherwise reuse/generate a local token

Updates public VITE_SUI_* configuration in Web-Osu-Mania/.env.local and
the two scoring bindings in Web-Osu-Mania/.dev.vars, preserving other settings.
Requires Node 22+, npm, Rust/Cargo, curl, and the existing SRS file.
The Bridge hardware and player wallet must be connected in the browser.
HELP
    exit 0 ;;
  ""|--check) ;;
  *) echo "Unknown option: $1 (use --help)" >&2; exit 1 ;;
esac

for command in node npm cargo curl; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node 22+ is required"); process.exit(1); }'

export WEB_PORT="${WEB_PORT:-3000}" PROVER_PORT="${PROVER_PORT:-8092}"
export SUI_DEPLOYMENT_FILE="${SUI_DEPLOYMENT_FILE:-$ROOT_DIR/scoring/gkr-scoring-sui/docs/wallet-claims-testnet-20260927.json}"
export SUI_SRS_FILE="${SUI_SRS_FILE:-$ROOT_DIR/scoring/gkr-scoring-sui/artifacts/dev-srs-24.bin}"
export VERSU_RUN_DIR="$ROOT_DIR/scoring/gkr-scoring-sui/artifacts/local-stack"

# Parse dotenv as data, never execute it as shell code. Keep generated secrets local.
node --input-type=module - <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';

const fail = (message) => { throw new Error(message); };
const read = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const webPort = Number(process.env.WEB_PORT), proverPort = Number(process.env.PROVER_PORT);
for (const port of [webPort, proverPort]) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('Ports must be integers from 1024 to 65535');
}
if (webPort === proverPort) fail('WEB_PORT and PROVER_PORT must differ');
for (const port of [webPort, proverPort]) await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', () => reject(new Error(`Port ${port} is busy. Stop its server or choose WEB_PORT/PROVER_PORT.`)));
  server.listen(port, '127.0.0.1', () => server.close(resolve));
});

const manifest = JSON.parse(fs.readFileSync(process.env.SUI_DEPLOYMENT_FILE, 'utf8'));
if (manifest.network !== 'testnet') fail('This launcher is for Sui testnet');
for (const key of ['packageId', 'registryId', 'challengeId', 'srsId']) {
  if (!/^0x[0-9a-f]{64}$/i.test(manifest[key] ?? '')) fail(`Deployment is missing a valid ${key}`);
}
if (!fs.existsSync(process.env.SUI_SRS_FILE)) fail(`Missing SRS: ${process.env.SUI_SRS_FILE}. Supply the file matching this deployment.`);
const srsFile = path.resolve(process.env.SUI_SRS_FILE);
const fd = fs.openSync(srsFile, 'r');
const header = Buffer.alloc(12);
fs.readSync(fd, header, 0, header.length, 0);
fs.closeSync(fd);
if (header.toString('ascii', 0, 8) !== 'MGKRSRS1') fail('Expected the custom Sui .bin SRS, not a .ptau file');

const config = manifest.browserConfiguration;
if (!config) fail('Deployment has no browserConfiguration; activate it first');
const publicVars = {};
for (const key of ['VITE_SUI_PACKAGE_ID', 'VITE_SUI_REGISTRY_ID', 'VITE_SUI_CHALLENGE_ID',
  'VITE_SUI_EASY_CHART_HASH', 'VITE_SUI_HARD_CHART_HASH', 'VITE_SUI_USDC_TYPE', 'VITE_SUI_INSECURE_DEMO', 'VITE_BEATMAP_URL']) {
  if (typeof config[key] !== 'string' || /[\r\n]/.test(config[key])) fail(`Missing or invalid ${key}`);
  publicVars[key] = config[key];
}
if (config.VITE_SUI_PACKAGE_ID !== manifest.packageId || config.VITE_SUI_REGISTRY_ID !== manifest.registryId ||
    config.VITE_SUI_CHALLENGE_ID !== manifest.challengeId) fail('Manifest and browser deployment IDs disagree');
const rpc = manifest.rpc ?? 'https://fullnode.testnet.sui.io:443';
if (new URL(rpc).protocol !== 'https:') fail('Testnet RPC must use HTTPS');
Object.assign(publicVars, { VITE_SUI_NETWORK: 'testnet', VITE_SUI_GRPC_URL: rpc });

const runDir = process.env.VERSU_RUN_DIR;
fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
const envFile = 'Web-Osu-Mania/.env.local', varsFile = 'Web-Osu-Mania/.dev.vars';
const localEnv = parseEnv(read(envFile));
const workerEnv = {};
// Creating .dev.vars disables the plugin's dotenv fallback; retain its existing secrets.
for (const file of ['.env', '.env.local', '.env.development', '.env.development.local']) {
  for (const [key, value] of Object.entries(parseEnv(read(`Web-Osu-Mania/${file}`)))) {
    if (!key.startsWith('VITE_')) workerEnv[key] = value;
  }
}
Object.assign(workerEnv, parseEnv(read(varsFile)));
const tokenFile = path.join(runDir, 'prover.token');
const token = process.env.PROVER_API_TOKEN || workerEnv.SUI_SCORING_API_TOKEN || read(tokenFile).trim() || randomBytes(32).toString('hex');
if (token.length < 32 || /[^\x21-\x7e]/.test(token)) fail('Prover token must contain at least 32 printable non-space ASCII characters');
const mergeEnv = (file, values, initial = read(file)) => {
  let text = initial;
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${JSON.stringify(value)}`;
    const pattern = new RegExp(`^(?:export\\s+)?${key}=[^\\r\\n]*`, 'm');
    text = pattern.test(text) ? text.replace(pattern, () => line) : `${text}${text.endsWith('\n') || !text ? '' : '\n'}${line}\n`;
  }
  fs.writeFileSync(file, text, { mode: 0o600 });
};
publicVars.VITE_SUI_PROOF_BUFFER_SECONDS = localEnv.VITE_SUI_PROOF_BUFFER_SECONDS || '900';
mergeEnv(envFile, publicVars);
const origin = `http://127.0.0.1:${proverPort}`;
const scoringVars = { SUI_SCORING_ORIGIN: origin, SUI_SCORING_API_TOKEN: token };
mergeEnv(varsFile, fs.existsSync(varsFile) ? scoringVars : { ...workerEnv, ...scoringVars });
fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
const processEnv = { ...publicVars, SUI_NETWORK: 'testnet', SUI_RPC_URL: rpc,
  SUI_PACKAGE_ID: manifest.packageId, SUI_REGISTRY_ID: manifest.registryId,
  SUI_SRS_FILE: srsFile, PROVER_API_TOKEN: token };
// Read by Bash using quoted export, not eval/source; values are not shell syntax.
for (const value of Object.values(processEnv)) if (/[\r\n]/.test(value)) fail('Multiline runtime values are unsupported');
fs.writeFileSync(path.join(runDir, 'process.env'), Object.entries(processEnv).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600 });
console.log(`Configured testnet Challenge ${manifest.challengeId}`);
const deadline = manifest.scoreDeadline ?? (manifest.scoreDeadlineMs ? new Date(Number(manifest.scoreDeadlineMs)).toISOString() : null);
if (deadline) console.log(`Scoring closes: ${deadline}${Date.parse(deadline) <= Date.now() ? ' (already closed; startup does not create a new round)' : ''}`);
if (manifest.insecureDemo) console.log('Development-SRS demo: use test tokens only.');
NODE

while IFS= read -r entry; do export "$entry"; done < "$VERSU_RUN_DIR/process.env"
if [[ ! -x Web-Osu-Mania/node_modules/.bin/vite ]]; then
  npm ci --prefix Web-Osu-Mania
fi
if [[ ! -d scoring/gkr-scoring-sui/scripts/node_modules/@mysten/sui ]]; then
  npm ci --prefix scoring/gkr-scoring-sui/scripts
fi

# Always use Cargo's incremental check: an existing binary may be the old raw prover.
echo 'Building the Sui hardware scoring service…'
cargo build --manifest-path scoring/Cargo.toml --release --locked -p mania-gkr-sui-prove-server

PROVER_PID=''
WEB_PID=''
cleanup() {
  trap - EXIT INT TERM
  for pid in "$WEB_PID" "$PROVER_PID"; do
    if [[ -n "$pid" ]]; then kill -TERM -- "-$pid" 2>/dev/null || true; fi
  done
  for pid in "$WEB_PID" "$PROVER_PID"; do
    if [[ -n "$pid" ]]; then wait "$pid" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Give each service its own process group so cleanup also stops workerd/proof helpers.
set -m
scoring/target/release/mania-gkr-sui-prove-server \
  --bind "127.0.0.1:$PROVER_PORT" --srs "$SUI_SRS_FILE" \
  --rpc "$SUI_RPC_URL" --registry "$SUI_REGISTRY_ID" --package "$SUI_PACKAGE_ID" \
  --jobs "$VERSU_RUN_DIR/proof-jobs" > "$VERSU_RUN_DIR/prover.log" 2>&1 &
PROVER_PID=$!

wait_ready() {
  local url="$1" pid="$2" log="$3" attempt
  for ((attempt=0; attempt<90; attempt++)); do
    if ! kill -0 "$pid" 2>/dev/null; then tail -n 30 "$log" >&2; return 1; fi
    if curl --silent --fail --max-time 2 "$url" > /dev/null; then return 0; fi
    sleep 1
  done
  echo "Timed out waiting for $url; see $log" >&2
  return 1
}
wait_ready "http://127.0.0.1:$PROVER_PORT/healthz" "$PROVER_PID" "$VERSU_RUN_DIR/prover.log"

(
  cd Web-Osu-Mania
  exec node node_modules/vite/bin/vite.js --host 127.0.0.1 --port "$WEB_PORT" --strictPort
) > "$VERSU_RUN_DIR/web.log" 2>&1 &
WEB_PID=$!
wait_ready "http://127.0.0.1:$WEB_PORT/api/scoring/info" "$WEB_PID" "$VERSU_RUN_DIR/web.log"

# This exercises the web -> authenticated prover connection, not just two health ports.
node --input-type=module - <<'NODE'
import fs from 'node:fs';
const manifest = JSON.parse(fs.readFileSync(process.env.SUI_DEPLOYMENT_FILE, 'utf8'));
const response = await fetch(`http://127.0.0.1:${process.env.WEB_PORT}/api/scoring/info`, { signal: AbortSignal.timeout(10000) });
const info = await response.json();
if (!response.ok || info.system !== 'gkr-sui-hardware' || info.mode !== 3 ||
    info.packageId !== manifest.packageId || info.registryId !== manifest.registryId || info.srsId !== manifest.srsId) {
  throw new Error('Scoring proxy, deployment IDs, or SRS do not match. Check local-stack logs.');
}
console.log('Web -> authenticated hardware prover: verified');
NODE

echo "Web app: http://127.0.0.1:$WEB_PORT"
echo "Prover:  http://127.0.0.1:$PROVER_PORT"
echo "Logs:    $VERSU_RUN_DIR/{web,prover}.log"
echo 'Connect the Bridge over USB and your funded Sui testnet wallet in the browser.'
if [[ "${1:-}" == --check ]]; then exit 0; fi
echo 'Press Ctrl-C to stop both services.'
while kill -0 "$PROVER_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do sleep 1; done
echo 'A service exited; stopping the stack. Check its log.' >&2
exit 1
