import assert from 'node:assert/strict';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { piPackageDir } from './pi-runtime.mjs';
const pi = piPackageDir();
export const sdk = await import(pathToFileURL(path.join(pi, 'dist/index.js')));
export const ai = await import(pathToFileURL(path.join(pi, 'node_modules/@earendil-works/pi-ai/dist/index.js')));
export const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const tc = (name, args, id) => ai.fauxAssistantMessage(ai.fauxToolCall(name, args, { id }), { stopReason: 'toolUse' });
export const lastResult = (ctx) => ctx.messages.filter(m => m.role === 'toolResult').at(-1);

export async function openSession(tv, opts = {}) {
  const previous = process.env.OBSIDIAN_LEARNING_CONFIG;
  const previousVault = process.env.OBSIDIAN_LEARNING_VAULT;
  process.env.OBSIDIAN_LEARNING_CONFIG = tv.configFile;
  delete process.env.OBSIDIAN_LEARNING_VAULT;
  const agentDir = path.join(tv.tmp, 'agent');
  const settings = sdk.SettingsManager.inMemory({ defaultProjectTrust: 'always', retry: { enabled: false }, compaction: { enabled: false } }, { projectTrusted: true });
  const loader = new sdk.DefaultResourceLoader({
    cwd: tv.tmp, agentDir, settingsManager: settings,
    additionalExtensionPaths: [
      path.join(project, 'obsidian-learning/extension/index.ts'),
      ...['quiz.ts', 'ask-user-question.ts', 'md-log.ts'].map(p => path.join(project, '.pi/extensions', p)),
    ],
    additionalSkillPaths: [path.join(project, '.pi/skills'), path.join(project, 'obsidian-learning/skills')],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const faux = ai.fauxProvider({ tokensPerSecond: 0 });
  const runtime = await sdk.ModelRuntime.create({ authPath: path.join(tv.tmp, 'auth.json'), modelsPath: null });
  runtime.registerNativeProvider(faux.provider);
  const { session } = await sdk.createAgentSession({ cwd: tv.tmp, agentDir, resourceLoader: loader, settingsManager: settings, modelRuntime: runtime, model: faux.getModel(), sessionManager: opts.sessionManager ?? sdk.SessionManager.inMemory(tv.tmp), thinkingLevel: 'off' });
  const errors = [];
  const screens = [];
  const inputs = [...(opts.inputs ?? [])];
  const theme = { fg: (_c, s) => s, bg: (_c, s) => s, bold: s => s, italic: s => s, underline: s => s };
  const ui = {
    theme, notify() {}, setStatus() {}, setEditorText(s) { screens.push(s); },
    confirm: async () => true, input: async () => '', select: async (_t, values) => values[0],
    custom: factory => new Promise((resolve, reject) => {
      try {
        const tui = { requestRender() {}, terminal: { columns: 100, rows: 40 } };
        const component = factory(tui, theme, {}, resolve);
        screens.push(component.render(100).join('\n'));
        const keys = inputs.shift() ?? ['\r', '\r'];
        for (const key of keys) component.handleInput(key);
      } catch (e) { reject(e); }
    }),
  };
  await session.bindExtensions({ ...(opts.hasUI === false ? {} : { uiContext: ui, mode: 'tui' }), onError: e => errors.push(e) });
  return {
    session, faux, loader, screens, errors,
    async run(prompt, responses) {
      faux.setResponses([...responses, ai.fauxAssistantMessage('Fine.')]);
      const before = session.messages.length;
      await session.prompt(prompt);
      const messages = session.messages.slice(before);
      assert.equal(messages.find(m => m.role === 'assistant' && m.errorMessage)?.errorMessage, undefined);
      return messages.filter(m => m.role === 'toolResult');
    },
    async close() {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
      session.dispose();
      if (previous === undefined) delete process.env.OBSIDIAN_LEARNING_CONFIG; else process.env.OBSIDIAN_LEARNING_CONFIG = previous;
      if (previousVault === undefined) delete process.env.OBSIDIAN_LEARNING_VAULT; else process.env.OBSIDIAN_LEARNING_VAULT = previousVault;
    },
  };
}
