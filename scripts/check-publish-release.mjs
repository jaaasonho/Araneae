import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {publishRelease} from './publish-release.mjs';

const names = ['Araneae_0.0.2_macos-arm64.dmg', 'Araneae_0.0.2_macos-x64.dmg', 'Araneae_0.0.2_windows-x64-setup.exe'];
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const asset = (name, bytes) => ({name, state: 'uploaded', digest: hash(bytes)});
const manifest = assets => Buffer.from(assets.map(item => `${item.digest.slice(7)}  ${item.name}\n`).join(''));

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'araneae-publish-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  for (const name of names) await writeFile(join(directory, name), name);
  const calls = [];
  return {directory, calls, options: {repo: 'example/Araneae', tag: 'v0.0.2', token: 'test-token',
    directory, run: args => calls.push(args)}};
}

test('only a missing release creates a release with all three installers and checksums', async t => {
  const {options, calls} = await fixture(t);
  await publishRelease({...options, request: async () => new Response(null, {status: 404})});
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ['release', 'create', 'v0.0.2']);
  for (const name of [...names, 'SHA256SUMS.txt']) assert(calls[0].includes(join(options.directory, name)));
  assert(calls[0].includes('--verify-tag'));
});

test('an existing release receives missing files without recreating it or editing its notes', async t => {
  const {options, calls} = await fixture(t);
  await publishRelease({...options, request: async () => Response.json({assets: [], immutable: false})});
  assert.equal(calls.length, 2);
  assert(calls.every(args => args[0] === 'release' && args[1] === 'upload'));
  assert(calls.every(args => !args.includes('--clobber')));
});

test('rerunning a complete release preserves published installers even if the new build bytes differ', async t => {
  const {options, calls} = await fixture(t);
  const assets = names.map(name => asset(name, 'already-published-' + name));
  const bytes = manifest(assets);
  assets.push(asset('SHA256SUMS.txt', bytes));
  await publishRelease({...options, request: async () => Response.json({assets, immutable: true})});
  assert.deepEqual(calls, []);
  assert.deepEqual(await readFile(join(options.directory, 'SHA256SUMS.txt')), bytes);
});

test('partial upload recovery adds missing installers and repairs only the checksum attachment', async t => {
  const {options, calls} = await fixture(t);
  const published = asset(names[0], 'published-arm64');
  await publishRelease({...options, request: async () => Response.json({assets: [published, asset('SHA256SUMS.txt', 'old')], immutable: false})});
  assert(!calls[0].includes(join(options.directory, names[0])));
  assert(!calls[0].includes('--clobber'));
  assert(calls[1].includes('--clobber'));
  const bytes = await readFile(join(options.directory, 'SHA256SUMS.txt'), 'utf8');
  assert(bytes.includes(`${published.digest.slice(7)}  ${names[0]}`));
});

test('API errors and malformed existing installers fail before any release mutation', async t => {
  const {options, calls} = await fixture(t);
  for (const status of [403, 500]) {
    await assert.rejects(publishRelease({...options, request: async () => new Response(null, {status})}), /Could not inspect release/);
  }
  await assert.rejects(publishRelease({...options, request: async () => { throw new Error('Network unavailable'); }}), /Network unavailable/);
  await assert.rejects(publishRelease({...options, request: async () => Response.json({assets: [{name: names[0], state: 'uploaded'}]})}), /no verified SHA-256/);
  assert.deepEqual(calls, []);
});

test('an incomplete immutable release and upload failures are surfaced', async t => {
  const {options, calls} = await fixture(t);
  await assert.rejects(publishRelease({...options, request: async () => Response.json({assets: [], immutable: true})}), /immutable/);
  assert.deepEqual(calls, []);
  await assert.rejects(publishRelease({...options, request: async () => Response.json({assets: []}),
    run: () => { throw new Error('Upload failed'); }}), /Upload failed/);
});
