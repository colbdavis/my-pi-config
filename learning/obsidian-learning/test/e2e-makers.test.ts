import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { makeVault } from './helpers/vault.ts';
import { ai, sdk, project, tc } from './helpers/session.mjs';

test('maker role loads upstream authoring tools, restricts access, and publishes a rendered PNG in the child cwd', async () => {
  const tv = makeVault(); tv.store.init();
  const prev = process.env.OBSIDIAN_LEARNING_CONFIG;
  process.env.OBSIDIAN_LEARNING_CONFIG = tv.configFile;
  let session;
  try {
    const workspace = path.join(tv.tmp, 'maker'); fs.mkdirSync(workspace);
    fs.symlinkSync(path.join(tv.root, '8 - Learning System/Visuals'), path.join(workspace, 'viz'));
    const settings = sdk.SettingsManager.inMemory({ defaultProjectTrust: 'always', retry: { enabled: false } }, { projectTrusted: true });
    const loader = new sdk.DefaultResourceLoader({ cwd: workspace, agentDir: path.join(tv.tmp, 'agent'), settingsManager: settings, additionalExtensionPaths: [path.join(project, 'obsidian-learning/agent-workspaces/svg-maker/.pi/extensions/role.ts')] });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const faux = ai.fauxProvider({ tokensPerSecond: 0 });
    const runtime = await sdk.ModelRuntime.create({ authPath: path.join(tv.tmp, 'auth.json'), modelsPath: null }); runtime.registerNativeProvider(faux.provider);
    ({ session } = await sdk.createAgentSession({ cwd: workspace, resourceLoader: loader, settingsManager: settings, modelRuntime: runtime, model: faux.getModel(), sessionManager: sdk.SessionManager.inMemory(workspace), thinkingLevel: 'off' }));
    await session.bindExtensions({});
    assert.deepEqual(session.getActiveToolNames().sort(), ['edit_svg', 'read', 'render_svg', 'write_svg']);
    faux.setResponses([
      tc('write_svg', { source: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="30" fill="blue"/></svg>' }),
      tc('render_svg', { save_as: 'test-circle' }), ai.fauxAssistantMessage('Rendered.'),
    ]);
    await session.prompt('Create a blue circle.');
    const results = session.messages.filter(m => m.role === 'toolResult');
    assert.ok(results.every(r => !r.isError), JSON.stringify(results.map(r => r.content.filter(c => c.type === 'text'))));
    const result = results.at(-1);
    assert.equal(result.details.ok, true);
    assert.ok(result.content.some(c => c.type === 'image'));
    assert.ok(result.details.path.startsWith(path.join(workspace, 'viz') + path.sep));
    const png = fs.readFileSync(path.join(tv.root, '8 - Learning System/Visuals', result.details.filename));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' }); session.dispose(); }
    if (prev === undefined) delete process.env.OBSIDIAN_LEARNING_CONFIG; else process.env.OBSIDIAN_LEARNING_CONFIG = prev;
    tv.cleanup();
  }
});
