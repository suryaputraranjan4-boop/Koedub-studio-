import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChunkPlan, validateMediaFile } from './mediaInspector';

test('validateMediaFile accepts supported video and audio containers', () => {
  const mp4 = validateMediaFile('episode_01.mp4', 'video/mp4', 1024 * 1024);
  assert.equal(mp4.valid, true);
  assert.equal(mp4.spec?.kind, 'video');

  const wav = validateMediaFile('dialogue_master.wav', 'audio/wav', 512 * 1024);
  assert.equal(wav.valid, true);
  assert.equal(wav.spec?.kind, 'audio');
});

test('validateMediaFile rejects unsupported extensions, empty files, and mismatched MIME types', () => {
  const txt = validateMediaFile('script.txt', 'text/plain', 200);
  assert.equal(txt.valid, false);
  assert.match(txt.errorMessage ?? '', /Unsupported file format/);

  const empty = validateMediaFile('episode.mp4', 'video/mp4', 0);
  assert.equal(empty.valid, false);
  assert.match(empty.errorMessage ?? '', /empty/);

  const fakeMp4 = validateMediaFile('spoof.mp4', 'text/html', 500);
  assert.equal(fakeMp4.valid, false);
  assert.match(fakeMp4.errorMessage ?? '', /MIME type/);
});

test('buildChunkPlan partitions long media into overlapping chunks cleanly', () => {
  const chunks = buildChunkPlan(75000, 30000, 2000);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].startMs, 0);
  assert.equal(chunks[0].endMs, 30000);
  assert.equal(chunks[0].overlapEndMs, 32000);

  assert.equal(chunks[1].startMs, 30000);
  assert.equal(chunks[1].overlapStartMs, 28000);
  assert.equal(chunks[1].endMs, 60000);
  assert.equal(chunks[1].overlapEndMs, 62000);

  assert.equal(chunks[2].startMs, 60000);
  assert.equal(chunks[2].overlapStartMs, 58000);
  assert.equal(chunks[2].endMs, 75000);
  assert.equal(chunks[2].overlapEndMs, 75000);
});
