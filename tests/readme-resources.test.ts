import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkDocument, verifyResources } from '../scripts/check-readme-resources.mjs';
import { distributionFiles, distributionDocuments } from '../scripts/distribution.ts';

test('README viewing resources and shipped browser dependencies resolve locally with matching hashes', async () => {
  const result = await verifyResources();
  assert(result.localReferences > 100);
  assert(result.verifiedHashes > 100);
});

test('each OpenGame README language links its guide and bundled game captures', async () => {
  const pages = [
    ['README.md', 'English'],
    ['docs/README.zh-CN.md', '简体中文'],
    ['docs/README.ja.md', '日本語'],
  ];
  const shipped = new Set(distributionDocuments);
  const manifest = JSON.parse(await readFile('docs/readme/opengame/manifest.json', 'utf8'));
  for (const [file, language] of [...pages, ['README.zh-CN.md', '简体中文']]) {
    const text = await readFile(file, 'utf8');
    await checkDocument(file);
    const selector = text.split('\n').find(line => line.includes(`**${language}**`) && line.includes(' · '));
    assert(selector, `Missing language selector in ${file}`);
    const destinations = [...selector.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)]
      .map(([, label, target]) => [path.normalize(path.join(path.dirname(file), target)), label]);
    assert.deepEqual(destinations, pages.filter(([, label]) => label !== language)
      .map(([target, label]) => [target, label]), file);
    for (const section of ['quick-start', 'agent-wall', 'showcase', 'features', 'technical-guide', 'community']) {
      assert(text.includes(`id="${section}"`), `${file}: missing ${section}`);
    }
    assert(text.includes('https://github.com/OpenDesignHQ/opengame.git'), file);
    assert(!text.includes('capcut-claude-motion-cover'), `${file}: stale video cover`);
    assert(!text.includes('npx skills add nexu-io/openmotion'), `${file}: upstream installer`);
    for (const asset of manifest.files) {
      const relative = path.relative(path.dirname(file), asset.file).split(path.sep).join('/');
      if (asset.display !== false) assert(text.includes(`src="${relative}"`), `${file}: missing ${asset.file}`);
      assert(shipped.has(asset.file), `Missing from distribution: ${asset.file}`);
    }
  }
  assert(shipped.has('docs/opengame-setup.md'));
});

test('copied native templates carry every registered asset in the distributable application', async () => {
  const shipped = new Set(await distributionFiles('phase1'));
  for (const id of ['product-promo', 'nyt-graph', 'decision-tree']) {
    const base = `template-library/${id}/`;
    const registry = JSON.parse(await readFile(base + 'registry-item.json', 'utf8'));
    for (const file of registry.files) assert(shipped.has(base + file.path), `Missing template asset: ${base + file.path}`);
  }
});

test('resource checks reject hotlinked media and missing files while allowing source attribution', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'motion-readme-assets-'));
  try {
    const file = path.join(dir, 'README.md');
    for (const text of ['![cover](https://example.org/image)', '<img src="https://example.org/cover.png">', '[Watch](https://example.org/demo.mp4)', '[Watch](missing.mp4)']) {
      await writeFile(file, text);
      await assert.rejects(checkDocument(file));
    }
    await writeFile(path.join(dir, 'demo.mp4'), 'test fixture');
    await writeFile(file, '[Watch](demo.mp4) · [Original author](https://example.org/author)');
    assert.equal(await checkDocument(file), 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('README displays registered public media without requiring its optional local copy', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'motion-public-readme-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'README.md');
  const url = `https://releases.open-design.ai/open-motion/media/sha256/${'a'.repeat(64)}.gif`;
  await writeFile(file, `<img src="${url}">`);
  assert.equal(await checkDocument(file, new Set([url])), 0);
  await assert.rejects(checkDocument(file), /external display/);
  await writeFile(file, `<img src="${url.replace('a'.repeat(64), 'b'.repeat(64))}">`);
  await assert.rejects(checkDocument(file, new Set([url])), /external display/);
});

test('only the repository-owned daily star chart is allowed as a live picture source', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'motion-star-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'README.md');
  const url = 'https://raw.githubusercontent.com/nexu-io/openmotion/readme-charts/star-history.svg';
  await writeFile(file, `<source srcset="${url}">`);
  await checkDocument(file);
  for (const source of [url.replace('/nexu-io/', '/another-owner/'), url.replace('/readme-charts/', '/main/')]) {
    await writeFile(file, `<source srcset="${source}">`);
    await assert.rejects(checkDocument(file), /external display/);
  }
});

test('README rejects oversized embedded images but keeps original download links valid', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'motion-readme-proxy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'README.md');
  const url = `https://releases.open-design.ai/open-motion/media/sha256/${'a'.repeat(64)}.gif`;
  const registered = new Set([url]);
  const sizes = new Map([[url, 5_000_001]]);
  for (const embedded of [`<img src="${url}">`, `![Preview](${url})`]) {
    await writeFile(file, embedded);
    await assert.rejects(checkDocument(file, registered, sizes), /5 MB proxy limit/);
    assert.equal(await checkDocument(file, registered, new Map([[url, 4_000_000]])), 0);
  }
  await writeFile(file, `[Download original](${url})`);
  assert.equal(await checkDocument(file, registered, sizes), 0);
  await writeFile(path.join(dir, 'large.gif'), Buffer.alloc(5_000_001));
  await writeFile(file, '![Preview](large.gif)');
  await assert.rejects(checkDocument(file), /5 MB proxy limit/);
});
