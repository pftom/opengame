import assert from 'node:assert/strict';
import test from 'node:test';
import { phase1Tools, validateInput } from '../shared/phase1-tools.ts';
import { withTemplateAttribution } from '../shared/template-attribution.ts';
import { toolInputFields } from '../tracking/tool-fields.ts';
import { createTracker, validProperties, type PendingEvent } from '../tracking/core.ts';
import { omEvents } from '../tracking/events.ts';
import { distributionFiles } from '../scripts/distribution.ts';
import { fixture } from './fixtures.ts';

const copyAttemptId = '11111111-1111-4111-8111-111111111111';
const templateId = 'product-promo';
const schema = phase1Tools.find(tool => tool.name === 'openmotion_get_template')!.inputSchema;

test('copy instructions preserve explicit metadata and legacy calls remain valid', () => {
  for (const templateEntry of ['website', 'editor'] as const) {
    const prompt = withTemplateAttribution('My requirements:\n', templateId, copyAttemptId, templateEntry);
    const args = JSON.parse(prompt.split('\n')[1]!);
    assert.deepEqual(args, { templateId, copyAttemptId, templateEntry });
    validateInput(schema, args);
    const fields = { tool_name: 'motion_get_template', call_id: crypto.randomUUID(), accepted: true, ...toolInputFields('openmotion_get_template', args) };
    assert.equal(validProperties(omEvents, 'mcp_tool_started', fields), true);
    assert.equal(fields.template_id, templateId);
    assert.equal(fields.copy_attempt_id, copyAttemptId);
    assert.equal(fields.template_entry, templateEntry);
    assert.match(prompt, /only if each is declared/);
    assert.match(prompt, /retry once with only/);
  }
  validateInput(schema, { templateId });
  assert.deepEqual(toolInputFields('motion_get_template', { templateId }), { template_id: templateId });
  assert.deepEqual(toolInputFields('openmotion_get_project', { templateId, copyAttemptId }), {});
  for (const args of [{ templateId, copyAttemptId: 'bad' }, { templateId, templateEntry: 'inferred' }, { templateId, extra: true }]) {
    assert.throws(() => validateInput(schema, args));
  }
});

test('actual MCP RPC reads emit one matching start/result pair with optional copy metadata', () => fixture(async store => {
  const { rpc, mcpRegistry } = await import('../mcp.ts');
  const events: PendingEvent[] = [];
  const tracking = createTracker({ registry: omEvents, entrypoint: 'mcp', enabled: true, flushIntervalMs: 0,
    send: async batch => { events.push(...batch); return 'accepted'; } });
  store.tracking = tracking;
  try {
    for (const arguments_ of [{ templateId, copyAttemptId, templateEntry: 'website' }, { templateId }]) {
      events.length = 0;
      const response: any = await rpc({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call',
        params: { name: 'openmotion_get_template', arguments: arguments_ } }, store, mcpRegistry('phase1'));
      assert.equal(response.error, undefined);
      assert.notEqual(response.result?.isError, true, JSON.stringify(response));
      await tracking.flush();
      const reads = events.filter(row => row.event === 'mcp_tool_started' || row.event === 'mcp_tool_finished');
      assert.deepEqual(reads.map(row => row.event), ['mcp_tool_started', 'mcp_tool_finished']);
      assert.equal(reads[0]!.properties.call_id, reads[1]!.properties.call_id);
      for (const row of reads) {
        assert.equal(row.properties.template_id, templateId);
        assert.equal(row.properties.copy_attempt_id, arguments_.copyAttemptId);
        assert.equal(row.properties.template_entry, arguments_.templateEntry);
      }
      assert.equal(reads[1]!.properties.outcome, 'success');
    }
  } finally { tracking.close(); }
}));

test('both distribution profiles ship the new schema dependency', async () => {
  for (const profile of ['legacy', 'phase1'] as const) {
    const files = await distributionFiles(profile, file => file.startsWith('shared/') || file.startsWith('tracking/'));
    assert.equal(files.includes('shared/template-attribution.ts'), true, profile);
  }
});
