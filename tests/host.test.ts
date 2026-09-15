import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

let LastBrainPlugin: any;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class PluginStub {
  app: any;
  constructor(app: any) { this.app = app; }
  async loadData() { return this.__loadData?.() ?? null; }
  async saveData(data: unknown) { return this.__saveData?.(data); }
  registerView() {}
  addRibbonIcon() {}
  addCommand() {}
  addSettingTab() {}
  __loadData?: () => unknown;
  __saveData?: (data: unknown) => unknown;
}
class ModalStub { constructor(_app: unknown) {} open() {} }
class SettingTabStub { constructor(_app: unknown, _plugin: unknown) {} }
class SettingStub {}
class TFileStub { extension = 'md'; }
class ItemViewStub {}

const obsidian = {
  App: class {}, Notice: class {}, Plugin: PluginStub, PluginSettingTab: SettingTabStub, ItemView: ItemViewStub,
  Setting: SettingStub, TFile: TFileStub, Modal: ModalStub,
  requestUrl: (request: unknown) => requestHandler(request),
};
let requestHandler: (request: unknown) => Promise<any> = async () => { throw new Error('Unexpected request'); };
before(async () => {
  const bundle = await build({ entryPoints: ['src/main.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['obsidian', './model-settings'], write: false });
  const module = { exports: {} as any };
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, require: (name: string) => {
      if (name === 'obsidian') return obsidian;
      if (name === './model-settings') return { ModelSettingsModal: ModalStub };
      throw new Error(`Unexpected module ${name}`);
  }, crypto: { randomUUID }, structuredClone, setTimeout, clearTimeout, URL, window: { setTimeout },
  });
  LastBrainPlugin = module.exports.default;
});

function makePlugin(options: { files?: any[]; cachedRead?: (file: any) => Promise<string>; saved?: any } = {}) {
  const persisted: any[] = [];
  const requests: any[] = [];
  const requestWaiters: Array<() => void> = [];
  let requestIndex = 0;
  const app = {
    vault: {
      getMarkdownFiles: () => options.files ?? [],
      cachedRead: options.cachedRead ?? (async () => ''),
    },
    secretStorage: { getSecret: () => '' },
    workspace: { getLeavesOfType: () => [] },
  };
  const plugin = new LastBrainPlugin(app);
  plugin.__loadData = () => options.saved ?? null;
  plugin.__saveData = (data: unknown) => { persisted.push(structuredClone(data)); };
  requestHandler = request => {
    const response = deferred<any>();
    requests.push({ request, ...response });
    requestWaiters.shift()?.();
    return response.promise;
  };
  return {
    plugin, requests, persisted,
    nextRequest: async () => {
      if (requests.length > requestIndex) return requests[requestIndex++];
      await new Promise<void>(resolve => requestWaiters.push(resolve));
      return requests[requestIndex++];
    },
  };
}

function consent(plugin: any) {
  Object.assign(plugin.data.settings, { networkConsent: true, model: 'test-model', baseUrl: 'https://example.com/v1' });
}
const reply = (content = 'answer') => ({ status: 200, json: { choices: [{ message: { content } }] } });
async function waitForRequest(nextRequest: () => Promise<any>, sending: Promise<void>, plugin: any) {
  return Promise.race([nextRequest(), sending.then(() => { throw new Error(`send finished before request: ${plugin.error}`); })]);
}

test('send requires consent and only sends after consent is enabled', { timeout: 5000 }, async () => {
  const { plugin, requests, nextRequest } = makePlugin();
  await plugin.send('question without consent');
  assert.equal(requests.length, 0);
  assert.match(plugin.error, /请先在设置/);
  consent(plugin);
  const sending = plugin.send('question with consent');
  const pending = await waitForRequest(nextRequest, sending, plugin);
  assert.equal(requests.length, 1);
  pending.resolve(reply());
  await sending;
  assert.equal(plugin.data.conversations[0].messages.at(-1).content, 'answer');
});

test('stop during retrieval waits for the read to settle and prevents a model request', { timeout: 5000 }, async () => {
  const readStarted = deferred<void>();
  const read = deferred<string>();
  const file = { path: 'note.md', stat: { size: 10, mtime: 1 } };
  const { plugin, requests } = makePlugin({ files: [file], cachedRead: () => { readStarted.resolve(); return read.promise; } });
  consent(plugin);
  const sending = plugin.send('question');
  await readStarted.promise;
  plugin.stop();
  assert.equal(plugin.busy, true);
  read.resolve('source text');
  await sending;
  assert.equal(requests.length, 0);
  assert.equal(plugin.busy, false);
  assert.equal(plugin.data.conversations[0].messages.some((message: any) => message.role === 'assistant'), false);
});

test('stop during a request ignores its late answer and allows another send', { timeout: 5000 }, async () => {
  const { plugin, requests, nextRequest } = makePlugin();
  consent(plugin);
  const firstSend = plugin.send('first');
  const first = await waitForRequest(nextRequest, firstSend, plugin);
  plugin.stop();
  await firstSend;
  assert.equal(plugin.busy, false);
  first.resolve(reply('late answer'));
  assert.equal(plugin.data.conversations[0].messages.some((message: any) => message.content === 'late answer'), false);

  const secondSend = plugin.send('second');
  const second = await waitForRequest(nextRequest, secondSend, plugin);
  second.resolve(reply('new answer'));
  await secondSend;
  assert.equal(plugin.data.conversations[0].messages.at(-1).content, 'new answer');
});

test('memory edits require confirmation, validate content, and roll back when saving fails', { timeout: 5000 }, async () => {
  const { plugin } = makePlugin();
  plugin.data.memories = [{ id: 'm1', conversationId: 'c1', content: 'old', sources: [], createdAt: 1, status: 'draft' }];
  await assert.rejects(plugin.updateMemory('m1', '   ', true), /1–64,000/);
  await assert.rejects(plugin.updateMemory('m1', 'x'.repeat(64001), true), /1–64,000/);
  await plugin.updateMemory('m1', ' revised ', false);
  assert.equal(plugin.data.memories[0].content, 'revised');
  assert.equal(plugin.data.memories[0].status, 'draft');
  await plugin.updateMemory('m1', 'confirmed text', true);
  assert.equal(plugin.data.memories[0].status, 'confirmed');
  const before = structuredClone(plugin.data.memories[0]);
  plugin.saveData = async () => { throw new Error('synthetic save failure'); };
  await assert.rejects(plugin.updateMemory('m1', 'unsaved edit', true), /本地保存失败/);
  assert.deepEqual(plugin.data.memories[0], before);
});

test('loads prior plugin data and applies current defaults', { timeout: 5000 }, async () => {
  const oldData = {
    version: 1,
    settings: { baseUrl: 'https://example.com/v1', model: 'old-model', secretName: 'old-key', excludedFolders: '' },
    conversations: [{ id: 'c1', title: 'history', createdAt: 1, updatedAt: 2, messages: [{ id: 'u1', role: 'user', content: 'old question', createdAt: 1, sources: [] }] }],
    memories: [], activeConversationId: 'c1',
  };
  const { plugin } = makePlugin({ saved: oldData });
  await plugin.onload();
  assert.equal(plugin.data.conversations[0].messages[0].content, 'old question');
  assert.equal(plugin.data.settings.networkConsent, false);
  assert.equal(plugin.data.settings.contextChars, 16000);
});

test('chat searches past the old vault and single-file limits and reports exclusions separately from failures', { timeout: 5000 }, async () => {
  const files = [
    ...Array.from({ length: 21 }, (_, i) => ({ path: `a-${String(i).padStart(2, '0')}.md`, stat: { size: 1_000_000, mtime: 1 } })),
    { path: 'z-late-large.md', stat: { size: 1_500_000, mtime: 1 } },
    { path: 'broken.md', stat: { size: 10, mtime: 1 } },
    { path: 'Private/hidden.md', stat: { size: 10, mtime: 1 } },
  ];
  const read: string[] = [];
  const { plugin, nextRequest } = makePlugin({ files, cachedRead: async file => {
    read.push(file.path);
    if (file.path === 'broken.md') throw Error('unreadable');
    return file.path === 'z-late-large.md' ? 'latecoverage unique source evidence' : 'unrelated filler';
  } });
  consent(plugin);
  plugin.data.settings.excludedFolders = 'Private';
  const sending = plugin.send('latecoverage');
  const pending = await waitForRequest(nextRequest, sending, plugin);
  pending.resolve(reply());
  await sending;
  assert.equal(read.length, 23);
  assert.ok(read.includes('z-late-large.md'));
  assert.ok(!read.includes('Private/hidden.md'));
  assert.match(pending.request.body, /latecoverage unique source evidence/);
  assert.match(plugin.status, /已检索 22 篇/);
  assert.match(plugin.status, /已排除 1 篇/);
  assert.match(plugin.status, /读取失败 1 篇/);
  assert.doesNotMatch(plugin.status, /大小限制|跳过/);
});
