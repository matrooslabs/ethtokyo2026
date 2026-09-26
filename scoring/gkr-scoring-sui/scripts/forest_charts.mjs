// Deterministic Forest chart extraction. `--prepare` invokes the Rust GKR sidecar
// for the SRS-specific on-chain opening, and cross-checks its canonical bytes.
// No gameplay session, score or device signature is fabricated here.
//
// node forest_charts.mjs --inspect
// node forest_charts.mjs --prepare --srs ../artifacts/dev-srs-24.bin --out ./forest-prepared
// An SRS generated with a known seed is DEVELOPMENT-ONLY and not mainnet eligible.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const archive = resolve(scriptDir, '../../../Web-Osu-Mania/public/beatmaps/forest.osz');
const binary = resolve(scriptDir, '../../../scoring/target/release/mania-gkr-sui');
const sha256 = (bytes) => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const option = (name) => {
  const at = process.argv.indexOf(name);
  if (at < 0) return undefined;
  if (!process.argv[at + 1] || process.argv[at + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  return process.argv[at + 1];
};
const hexBytes = (value, field) => {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) {
    throw new Error(`Invalid hexadecimal ${field}`);
  }
  return Buffer.from(value.slice(2), 'hex');
};

function parseOsu(bytes, difficulty) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  let section = '';
  let mode;
  let keys;
  let version;
  const notes = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1);
      continue;
    }
    if (section === 'HitObjects') {
      const fields = line.split(',');
      if (fields.length < 5) throw new Error(`Invalid ${difficulty} hit object`);
      const x = Number(fields[0]);
      const startMs = Number(fields[2]);
      const kind = Number(fields[3]);
      const endMs = kind & 128 ? Number(fields[5]?.split(':')[0]) : startMs;
      if (![x, startMs, kind, endMs].every(Number.isSafeInteger) || x < 0 || x > 512 ||
          startMs < 0 || endMs < startMs || endMs > 1_800_000 || !(kind & 1 || kind & 128)) {
        throw new Error(`Invalid ${difficulty} mania note`);
      }
      notes.push({ lane: Math.min(Math.floor(x * 4 / 512), 3), start_us: startMs * 1000, end_us: endMs * 1000 });
    } else if (line.includes(':')) {
      const [key, ...rest] = line.split(':');
      const value = rest.join(':').trim();
      if (section === 'General' && key.trim() === 'Mode') mode = value;
      if (section === 'Difficulty' && key.trim() === 'CircleSize') keys = Number(value);
      if (section === 'Metadata' && key.trim() === 'Version') version = value;
    }
  }
  if (version !== difficulty || mode !== '3' || keys !== 4) {
    throw new Error(`${difficulty} archive entry is not the expected 4K mania version`);
  }
  const expectedCount = { Easy: 204, Hard: 1026 }[difficulty];
  if (notes.length !== expectedCount) throw new Error(`${difficulty}: expected ${expectedCount} notes, found ${notes.length}`);
  notes.sort((a, b) => a.start_us - b.start_us || a.lane - b.lane || a.end_us - b.end_us);
  const lastEnd = [-1, -1, -1, -1];
  for (const note of notes) {
    if (note.start_us <= lastEnd[note.lane]) throw new Error(`${difficulty}: overlapping lane notes`);
    lastEnd[note.lane] = note.end_us;
  }
  const chartBytes = Buffer.allocUnsafe(24 + notes.length * 17);
  chartBytes.write('OSUMANIA_CHART_V1', 0, 'ascii');
  chartBytes.writeUInt16BE(1, 17);
  chartBytes.writeUInt8(4, 19);
  chartBytes.writeUInt32BE(notes.length, 20);
  for (let i = 0; i < notes.length; i++) {
    const offset = 24 + i * 17;
    const note = notes[i];
    chartBytes.writeUInt8(note.lane, offset);
    chartBytes.writeBigUInt64BE(BigInt(note.start_us), offset + 1);
    chartBytes.writeBigUInt64BE(BigInt(note.end_us), offset + 9);
  }
  return { chart: { key_count: 4, notes }, chartBytes };
}

export function extractForest() {
  const entries = execFileSync('unzip', ['-Z', '-1', archive], { encoding: 'utf8' }).trimEnd().split('\n');
  const found = entries.filter((name) => name.endsWith('.osu'));
  if (found.length !== 2) throw new Error('Forest archive must contain exactly Easy and Hard .osu files');
  const out = {};
  for (const difficulty of ['Easy', 'Hard']) {
    const matches = found.filter((name) => name.endsWith(`[${difficulty}].osu`));
    if (matches.length !== 1) throw new Error(`Forest archive must contain exactly one ${difficulty} .osu`);
    // unzip treats member names as globs, including the literal [Easy]/[Hard] brackets.
    const literal = matches[0].replaceAll('[', '\\[').replaceAll(']', '\\]');
    const source = execFileSync('unzip', ['-p', archive, literal], { maxBuffer: 1 << 22 });
    const parsed = parseOsu(source, difficulty);
    out[difficulty.toLowerCase()] = {
      difficulty, osuEntry: matches[0], sourceHash: sha256(source).slice(2), chartHash: sha256(parsed.chartBytes),
      noteCount: parsed.chart.notes.length, ...parsed,
    };
  }
  if (out.easy.chartHash === out.hard.chartHash) throw new Error('Forest difficulties must be distinct charts');
  return out;
}

export function publicManifest(charts) {
  return Object.fromEntries(Object.entries(charts).map(([key, value]) => [key, {
    difficulty: value.difficulty, osuEntry: value.osuEntry, noteCount: value.noteCount,
    sourceHash: value.sourceHash, chartHash: value.chartHash,
    canonicalChartBytes: value.chartBytes.length,
  }]));
}

export function prepareForest(charts, srs, out) {
  const work = mkdtempSync(join(tmpdir(), 'forest-chart-'));
  try {
    mkdirSync(out, { recursive: true });
    let srsId;
    for (const [key, value] of Object.entries(charts)) {
      // Rust's prepare-chart accepts PlayInput, but reads ONLY .chart. Zero-valued
      // session metadata here is a serialization envelope, NOT gameplay evidence.
      const zeros = (count) => Array(count).fill(0);
      const input = {
        header: {
          chain_id: 0, verifier: zeros(20), match_id: zeros(32), session_id: zeros(32),
          challenge: zeros(32), player: zeros(20), device: zeros(20), chart_hash: zeros(32),
          ruleset_id: zeros(32), bitstream_hash: zeros(32), input_policy_hash: zeros(32),
        },
        footer: { event_count: 0, duration_us: 0, trace_root: zeros(32) },
        chart: value.chart, events: [],
      };
      const inputPath = join(work, `${key}.json`);
      writeFileSync(inputPath, JSON.stringify(input));
      const prepared = JSON.parse(execFileSync(binary, ['prepare-chart', '--srs', srs, '--input', inputPath],
        { encoding: 'utf8', maxBuffer: 1 << 24 }));
      if (!hexBytes(prepared.chartBytes, `${key} prepared chart`).equals(value.chartBytes) ||
          prepared.chartHash.toLowerCase() !== value.chartHash) {
        throw new Error(`${key}: Rust prepare-chart disagrees with the extracted canonical chart`);
      }
      if (srsId && srsId !== prepared.vk.srsId) throw new Error('SRS changed between chart preparations');
      srsId = prepared.vk.srsId;
      writeFileSync(join(out, `${key}.chart.bin`), value.chartBytes);
      writeFileSync(join(out, `${key}.prepared.json`), `${JSON.stringify(prepared, null, 2)}\n`);
    }
    return { srsId, artifacts: {
      easy: { chartBytes: join(out, 'easy.chart.bin'), registration: join(out, 'easy.prepared.json') },
      hard: { chartBytes: join(out, 'hard.chart.bin'), registration: join(out, 'hard.prepared.json') },
    } };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inspect = process.argv.includes('--inspect');
  const prepare = process.argv.includes('--prepare');
  if (inspect === prepare) throw new Error('Select exactly one of --inspect or --prepare');
  const charts = extractForest();
  const manifest = { archive, charts: publicManifest(charts) };
  if (prepare) {
    const srs = option('--srs');
    const out = option('--out');
    if (!srs || !out) throw new Error('--prepare requires --srs FILE and --out DIR');
    const resolvedSrs = resolve(srs);
    const result = prepareForest(charts, resolvedSrs, resolve(out));
    Object.assign(manifest, result, {
      srs: resolvedSrs,
      srsSecurity: /(^|\/)dev-srs-24\.bin$/.test(resolvedSrs)
        ? 'INSECURE DEVELOPMENT SRS: NOT MAINNET ELIGIBLE'
        : 'OPERATOR-SUPPLIED SRS: independently verify setup provenance before production use',
    });
    writeFileSync(join(resolve(out), 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  console.log(JSON.stringify(manifest, null, 2));
}
