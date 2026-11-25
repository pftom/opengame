import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './fixtures.ts';
import { gatewayFor } from '../gateway/service.ts';
import { mediaUse } from '../gateway/media-use.ts';
import { uuid } from '../tracking/core.ts';

for (const plan of ['free', 'go'] as const) {
  test(`${plan} inspect returns an attributed console link without account intents or opening a browser`, t => fixture(async store => {
    const gateway = gatewayFor(store);
    gateway.options.detect = async () => [];
    t.after(() => gateway.close());
    t.mock.method(gateway.account, 'summary', async () => ({ state: 'signed-in', plan, billingUnavailable: false }));
    // A signed-in production account must still return a credential-free console link.
    await mkdir(gateway.account.home, { recursive: true });
    await writeFile(path.join(store.directory, 'account/session.json'), JSON.stringify({ id: 'test-session' }));
    await writeFile(path.join(gateway.account.home, 'config.json'), JSON.stringify({ profiles: { prod: {
      apiUrl: 'https://amr-api.open-design.ai', user: { id: 'fixture-user' },
      controlKey: 'test-control', controlKeyId: 'test-id', runtimeKey: 'test-runtime',
    } } }));
    t.mock.method(gateway.account, 'mediaModels', async () => []);
    const fetcher = t.mock.fn(async () => Response.json({ intentId: 'must-not-be-exposed' }));
    gateway.account.options.fetcher = fetcher;
    const upgradeLink = gateway.account.upgradeLink.bind(gateway.account);
    t.mock.method(gateway.account, 'upgradeLink', (...args: Parameters<typeof upgradeLink>) => {
      assert.equal(args.length, 1, 'inspect only supplies the entry UUID');
      assert.match(args[0], uuid);
      return upgradeLink(...args);
    });
    const checkAttribution = (url: string, entryId: string) => {
      const target = new URL(url), params = target.searchParams;
      assert.equal(target.origin + target.pathname, 'https://open-design.ai/cloud/dashboard');
      assert.deepEqual([...params.keys()].sort(), ['billing', 'od_entry_at', 'od_entry_id', 'od_entry_source', 'od_origin', 'utm_medium', 'utm_source']);
      assert.equal(params.get('billing'), 'plan');
      assert.equal(params.get('od_origin'), 'openmotion');
      assert.equal(params.get('od_entry_source'), 'openmotion_manage_subscription');
      assert.equal(params.get('utm_source'), 'opengame');
      assert.equal(params.get('utm_medium'), 'agent');
      assert.match(params.get('od_entry_id')!, /^opengame-/);
      assert.equal(params.get('od_entry_id')!.slice('opengame-'.length), entryId);
      assert.equal(new Date(params.get('od_entry_at')!).toISOString(), params.get('od_entry_at'));
    };
    const result = await mediaUse(store, { action: 'inspect' });
    assert.ok(result.upgrade);
    assert.match(result.upgrade.entryId, uuid);
    assert.equal(result.upgrade.plan, 'plus');
    assert.match(result.upgrade.instruction, /clickable.*Upgrade to Plus \/ 升级到 Plus.*inspect again after payment.*original request/);
    checkAttribution(result.upgrade.url, result.upgrade.entryId);
    assert.equal(fetcher.mock.callCount(), 0, 'inspect must never request an account intent');
    assert.equal(result.settingsHandoff.arguments.entry, `agent_media_upgrade_${plan}`);
    assert.doesNotMatch(JSON.stringify(result), /test-control|test-runtime|fixture-user/);

    // Re-inspection creates a fresh attribution ID without creating credentials.
    const next = await mediaUse(store, { action: 'inspect' });
    assert.ok(next.upgrade);
    assert.notEqual(next.upgrade.entryId, result.upgrade.entryId);
    checkAttribution(next.upgrade.url, next.upgrade.entryId);
    assert.equal(fetcher.mock.callCount(), 0);
  }));
}

test('included, signed-out, rejected-key and usable alternative routes do not generate upgrade links', t => fixture(async store => {
  const gateway = gatewayFor(store);
  gateway.options.detect = async () => [];
  t.after(() => gateway.close());
  let state = 'signed-out', plan = 'plus';
  t.mock.method(gateway.account, 'summary', async () => ({ state, plan, billingUnavailable: false }));
  const open = t.mock.method(gateway.account, 'upgradeLink', () => { throw new Error('Must not generate an upgrade link'); });
  const inspect = async (entry?: string) => {
    const result = await mediaUse(store, { action: 'inspect' });
    assert.equal(Object.hasOwn(result, 'upgrade'), false);
    assert.equal(Object.hasOwn(result, '_upgradeLinkResult'), false);
    assert.equal(result.settingsHandoff.arguments.entry, entry);
  };
  await inspect('agent_media_signed_out');
  state = 'signed-in';
  await inspect();
  state = 'signed-out';
  await gateway.configureProvider('atlascloud', { apiKey: 'test-key' });
  await gateway.connections.verifyKey('atlascloud', 'test-key', 'rejected');
  await inspect('agent_media_key_rejected');
  state = 'signed-in'; plan = 'go';
  await gateway.connections.verifyKey('atlascloud', 'test-key', 'verified');
  await inspect();
  assert.equal(open.mock.callCount(), 0);
}));

test('upgrade URL exceptions preserve the settings handoff without returning upgrade', t => fixture(async store => {
  const gateway = gatewayFor(store);
  gateway.options.detect = async () => [];
  t.after(() => gateway.close());
  t.mock.method(gateway.account, 'summary', async () => ({ state: 'signed-in', plan: 'go', billingUnavailable: false }));
  t.mock.method(gateway.account, 'upgradeLink', () => { throw new Error('private-account-error'); });
  const result = await mediaUse(store, { action: 'inspect' });
  assert.equal(Object.hasOwn(result, 'upgrade'), false);
  assert.deepEqual(result.settingsHandoff.arguments, { target: 'providers', entry: 'agent_media_upgrade_go' });
  assert.deepEqual(result._upgradeLinkResult, { entry_from: 'agent_media_upgrade_go', outcome: 'failure' });
  assert.doesNotMatch(JSON.stringify(result), /private-account-error/);
}));
