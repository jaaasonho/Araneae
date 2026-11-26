import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

// Keep existing installer bytes stable when a tag or failed publishing job is rerun.
export async function publishRelease({repo, tag, token, directory = 'release', request = fetch,
  run = args => execFileSync('gh', args, {stdio: 'inherit'})}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(tag ?? '')) {
    throw new Error('A repository and semantic version tag are required');
  }
  if (!token) throw new Error('GH_TOKEN is required');
  const names = [`Araneae_${tag.slice(1)}_macos-arm64.dmg`,
    `Araneae_${tag.slice(1)}_macos-x64.dmg`, `Araneae_${tag.slice(1)}_windows-x64-setup.exe`];
  const files = await Promise.all(names.map(async name => {
    const path = join(directory, name), bytes = await readFile(path);
    if (!bytes.length) throw new Error(`Installer is empty: ${name}`);
    return {name, path, digest: digest(bytes)};
  }));
  const response = await request(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json'},
  });
  if (response.status !== 404 && !response.ok) {
    throw new Error(`Could not inspect release: HTTP ${response.status}`);
  }
  const existing = response.status === 404 ? null : await response.json();
  const pending = [], checksums = [];
  for (const file of files) {
    const asset = existing?.assets.find(item => item.name === file.name);
    if (asset && (asset.state !== 'uploaded' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? ''))) {
      throw new Error(`Existing installer has no verified SHA-256 digest: ${file.name}`);
    }
    if (!asset) pending.push(file.path);
    checksums.push(`${(asset?.digest ?? file.digest).slice(7)}  ${file.name}\n`);
  }
  const manifest = Buffer.from(checksums.join(''));
  const checksumPath = join(directory, 'SHA256SUMS.txt');
  await writeFile(checksumPath, manifest);
  if (!existing) {
    run(['release', 'create', tag, ...files.map(file => file.path), checksumPath,
      '--repo', repo, '--verify-tag', '--title', `Araneae ${tag}`, '--generate-notes']);
    return;
  }
  const checksum = existing.assets.find(asset => asset.name === 'SHA256SUMS.txt');
  const updateChecksum = checksum?.digest !== digest(manifest);
  if (existing.immutable && (pending.length || updateChecksum)) {
    throw new Error('Release is immutable and incomplete; publish a new version tag');
  }
  if (pending.length) run(['release', 'upload', tag, ...pending, '--repo', repo]);
  if (updateChecksum) {
    run(['release', 'upload', tag, checksumPath, '--repo', repo, ...(checksum ? ['--clobber'] : [])]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await publishRelease({repo: process.env.GH_REPO, tag: process.env.RELEASE_TAG, token: process.env.GH_TOKEN});
}
