// Checks that the bundled exercise library and the code that refers to it agree.
// Run with: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const library = JSON.parse(read('public/exercises/index.json'));
const steps = JSON.parse(read('public/exercises/steps.json'));
const byId = new Map(library.map((ex) => [ex.id, ex]));
const source = read('public/js/exercises.js');

test('the library is complete and every photo it promises is on disk', () => {
  assert.ok(library.length > 850, `only ${library.length} exercises`);
  for (const ex of library) {
    assert.match(ex.id, /^[A-Za-z0-9_-]{1,80}$/, `unsafe id ${ex.id}`);
    assert.ok(ex.name && ex.pm.length > 0, `incomplete record ${ex.id}`);
    assert.ok(Array.isArray(steps[ex.id]), `no how-to entry for ${ex.id}`);
    if (!ex.img) continue;
    for (const frame of ['0', '1', 't']) {
      assert.ok(fs.existsSync(path.join(root, 'public/exercises/img', ex.id, `${frame}.webp`)), `missing photo ${ex.id}/${frame}.webp`);
    }
  }
});

test('every exercise in the ready-made plans exists and has photos', () => {
  const ids = [...source.matchAll(/item\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(ids.length >= 70, 'the plan templates were not found in exercises.js');
  for (const id of new Set(ids)) {
    assert.ok(byId.has(id), `plan template refers to unknown exercise "${id}"`);
    assert.equal(byId.get(id).img, 1, `plan exercise "${id}" has no photos`);
  }
});

test('every warm-up move exists, has photos and has a cue', () => {
  const cueBlock = source.slice(source.indexOf('const WARMUP_CUE = {'), source.indexOf('const WARMUP_FOR = {'));
  const forBlock = source.slice(source.indexOf('const WARMUP_FOR = {'), source.indexOf('const UPPER'));
  const withCue = new Set([...cueBlock.matchAll(/^\s+([A-Za-z_-]+): '/gm)].map((m) => m[1]));
  const used = new Set([...forBlock.matchAll(/\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((q) => q[1])));
  for (const id of ['Arm_Circles', 'Standing_Hip_Circles', 'Sit_Squats', 'Cat_Stretch']) used.add(id);

  assert.ok(used.size >= 15, 'the warm-up table was not found in exercises.js');
  for (const id of used) {
    assert.ok(byId.has(id), `warm-up refers to unknown exercise "${id}"`);
    assert.equal(byId.get(id).img, 1, `warm-up move "${id}" has no photos`);
    assert.ok(withCue.has(id), `warm-up move "${id}" has no cue text`);
  }
});

test('every muscle and equipment value in the library has a label and a filter', () => {
  const muscles = new Set(library.flatMap((ex) => [...ex.pm, ...ex.sm]));
  const equipment = new Set(library.map((ex) => ex.eq));
  for (const muscle of muscles) assert.ok(source.includes(`'${muscle}'`) || source.includes(`${muscle}:`), `no label for muscle "${muscle}"`);
  for (const item of equipment) assert.ok(source.includes(`'${item}'`) || source.includes(`${item}:`), `no label for equipment "${item}"`);
});
