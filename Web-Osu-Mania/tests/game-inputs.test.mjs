import test from 'node:test';
import assert from 'node:assert/strict';
import { isHoldObject, laneForX, sectionLines } from '../src/lib/osuFields.ts';
import { recordTransition } from '../src/lib/replayInputs.ts';

test('hold flags and right-edge notes preserve four-lane layout', () => {
  assert.equal(isHoldObject(128), true);
  assert.equal(isHoldObject(132), true);
  assert.equal(isHoldObject(1), false);
  assert.equal(isHoldObject(5), false);
  assert.deepEqual([0,127,128,255,256,383,384,511,512].map(x => laneForX(x,4)), [0,0,1,1,2,2,3,3,3]);
});
test('chart parser retains last note and stops at the next section', () => {
  const notes = ['64,192,1000,1,0,0:0:0:0:', '512,192,2000,132,0,2500:0:0:0:0:'];
  assert.deepEqual(sectionLines(['[HitObjects]', ...notes], 'HitObjects'), notes);
  assert.deepEqual(sectionLines(['[HitObjects]', '', notes[0], '// comment', notes[1], '[Other]', 'not a note'], 'HitObjects'), notes);
  assert.deepEqual(sectionLines(['[Other]', 'other'], 'HitObjects'), []);
});
test('finish/fail cleanup releases only held keys without inventing input', () => {
  const states=[], inputs=[];
  recordTransition(states,inputs,3,0,false);
  recordTransition(states,inputs,0,1000,true);
  recordTransition(states,inputs,0,1020,false);
  recordTransition(states,inputs,1,1500,true);
  recordTransition(states,inputs,1,1501,true);
  for(let column=0;column<4;column++) recordTransition(states,inputs,column,3000,false);
  assert.deepEqual(inputs,[[0,1000,true],[0,1020,false],[1,1500,true],[1,3000,false]]);
  const empty=[];
  for(let column=0;column<4;column++) recordTransition([],empty,column,3000,false);
  assert.deepEqual(empty,[]);
});
