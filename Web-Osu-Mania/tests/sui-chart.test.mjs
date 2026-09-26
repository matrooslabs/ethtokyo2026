import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chartFromBeatmap, chartHash } from '../src/lib/sui/chart.ts';

test('browser chart hash matches Rust canonical scoring fixture', async () => {
  const fixture = JSON.parse(readFileSync(new URL('../../scoring/fixtures/demo.json', import.meta.url)));
  const expected = JSON.parse(readFileSync(new URL('../../scoring/fixtures/demo.expected.json', import.meta.url)));
  assert.equal(await chartHash(fixture.chart),
    '0x' + expected.result.chart_hash.map(byte => byte.toString(16).padStart(2, '0')).join(''));
});

test('browser display offset does not change canonical hold chart', () => {
  const chart = chartFromBeatmap({ delay: 1000, audioOffset: 50, hitObjects: [
    { type: 'tap', column: 2, time: 1450, endTime: 1700 },
    { type: 'hold', column: 2, time: 1450, endTime: 1700 },
  ] });
  assert.deepEqual(chart, { key_count: 4, notes: [{ lane: 2, start_us: 500000, end_us: 750000 }] });
});
