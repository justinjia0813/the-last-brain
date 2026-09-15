import test from 'node:test';
import assert from 'node:assert/strict';
import { retrieve } from '../src/retrieval';
import { buildRequest, parseCompletion } from '../src/model';
import { DEFAULT_SETTINGS, type CompletionInput, type Note } from '../src/types';

const settings = { ...DEFAULT_SETTINGS, model: 'test-model' };

test('retrieves a relevant late Chinese chunk and respects exclusions and total budget', () => {
  const long = `${'无关内容。'.repeat(500)}\n\n固态电池硫化物电解质供应链出现新进展。`;
  const notes: Note[] = [
    { path: 'Research/solid.md', text: long, mtime: 1 },
    { path: 'Research/private/solid.md', text: '固态电池', mtime: 2 },
    { path: 'Research/other.md', text: '完全不相关', mtime: 3 },
  ];
  const result = retrieve(notes, '固态电池 电解质', { ...settings, excludedFolders: 'Research/private', contextChars: 40, maxSources: 3 });
  assert.equal(result.sources.length, 1);
  assert.match(result.sources[0].text, /硫化物电解质/);
  assert.ok(result.sources.reduce((n, source) => n + source.text.length, 0) <= 40);
  assert.equal(retrieve(notes, 'quantum banana', settings).sources.length, 0);
});

test('retrieves English terms without falling back to unrelated notes', () => {
  const result = retrieve([{ path: 'notes/markets.md', text: 'Semiconductor supply chain outlook.', mtime: 9 }], 'supply chain', settings);
  assert.equal(result.sources[0].path, 'notes/markets.md');
  assert.equal(retrieve([{ path: 'notes/other.md', text: 'gardening', mtime: 9 }], 'semiconductor', settings).sources.length, 0);
});

test('counts only excluded notes as skipped, returns body for title hits and guards non-finite limits', () => {
  const result = retrieve([
    { path: 'Research/title-match.md', text: 'First body paragraph.', mtime: 1 },
    { path: 'Private/hidden.md', text: 'needle', mtime: 2 },
    { path: 'Other/no-match.md', text: 'unrelated', mtime: 3 },
  ], 'title match', { ...settings, excludedFolders: ' Private/ ', contextChars: Number.NaN, maxSources: Number.NaN });
  assert.equal(result.sources.length, 0);
  assert.equal(result.skipped, 1);
  const titled = retrieve([{ path: 'Research/title-match.md', text: 'First body paragraph.', mtime: 1 }], 'title-match', settings);
  assert.equal(titled.sources[0].text, 'First body paragraph.');
});

function input(overrides: Partial<CompletionInput> = {}): CompletionInput {
  return {
    settings: { ...settings, baseUrl: 'https://example.com/v1/' }, apiKey: '', mode: 'chat',
    messages: [{ id: '1', role: 'user', content: '固态电池进度？', createdAt: 1, sources: [] }],
    sources: [{ path: 'research/solid.md', text: '固态电池样品测试完成。', mtime: 1 }],
    memories: [
      { id: 'm1', conversationId: 'c', content: '固态电池项目方向', sources: [], createdAt: 1, status: 'confirmed' },
      { id: 'm2', conversationId: 'c', content: 'quantum computing', sources: [], createdAt: 1, status: 'confirmed' },
      { id: 'm3', conversationId: 'c', content: '固态电池草稿', sources: [], createdAt: 1, status: 'draft' },
    ], ...overrides,
  };
}

test('builds safe chat completion request with source framing and relevant confirmed memory', () => {
  const request = buildRequest(input());
  assert.equal(request.url, 'https://example.com/v1/chat/completions');
  assert.equal(request.headers.Authorization, undefined);
  const body = JSON.parse(request.body);
  const all = JSON.stringify(body);
  assert.match(all, /\[1\] research\/solid\.md/);
  assert.match(all, /untrusted_note/);
  assert.match(all, /固态电池项目方向/);
  assert.doesNotMatch(all, /quantum computing|固态电池草稿/);
  assert.equal('tools' in body, false);
  assert.equal(body.stream, false);
  assert.match(body.messages[0].content, /不得调用工具/);
  assert.equal(buildRequest(input({ settings: { ...settings, baseUrl: 'http://localhost:11434/v1/chat/completions///' }, apiKey: 'secret' })).url,
    'http://localhost:11434/v1/chat/completions');
  assert.equal(buildRequest(input({ apiKey: 'secret' })).headers.Authorization, 'Bearer secret');
});

test('validates model endpoint configuration', () => {
  assert.throws(() => buildRequest(input({ settings: { ...settings, model: '  ' } })), /模型/);
  assert.throws(() => buildRequest(input({ settings: { ...settings, baseUrl: 'http://example.com' } })), /模型/);
  assert.throws(() => buildRequest(input({ settings: { ...settings, baseUrl: 'https://user:pass@example.com/v1' } })), /模型地址不能/);
  assert.throws(() => buildRequest(input({ settings: { ...settings, baseUrl: 'https://example.com/v1?token=secret' } })), /模型地址不能/);
  assert.throws(() => buildRequest(input({ apiKey: 'bad\nheader' })), /模型密钥/);
});

test('bounds memory context and preserves the current question separately from history', () => {
  const current = '当前问题'.repeat(2500);
  const requestInput = input({
    messages: [
      { id: 'old', role: 'user', content: 'old'.repeat(5000), createdAt: 0, sources: [] },
      { id: 'current', role: 'user', content: current, createdAt: 1, sources: [] },
    ],
    memories: [{ id: 'huge', conversationId: 'c', content: `当前问题相关${'记忆'.repeat(5000)}`, sources: [], createdAt: 1, status: 'confirmed' }],
  });
  const body = JSON.parse(buildRequest(requestInput).body);
  const currentMessage = body.messages.at(-1).content;
  assert.equal(currentMessage, current.slice(0, 12000));
  const encoded = JSON.stringify(body);
  assert.ok(encoded.length < 30000);
  assert.match(encoded, /<confirmed_memory>/);
  assert.match(encoded, /\[已截断\]/);
});

test('memory prompt separates evidence, inference, unknowns and advice', () => {
  const body = JSON.parse(buildRequest(input({ mode: 'memory' })).body);
  assert.match(body.messages[0].content, /证据.*推断.*未知.*建议/);
  assert.match(body.messages[0].content, /用户明确陈述的偏好与笔记中的主张分开/);
  assert.match(body.messages[0].content, /不得调用工具/);
  const memoryInput = input({ mode: 'memory' });
  memoryInput.messages.push({ id: 'a', role: 'assistant', content: 'LATEST_ANSWER_MUST_BE_INCLUDED', createdAt: 2, sources: [] });
  const request = JSON.parse(buildRequest(memoryInput).body);
  assert.match(JSON.stringify(request), /LATEST_ANSWER_MUST_BE_INCLUDED/);
  assert.equal(request.messages.at(-1).role, 'user');
  assert.doesNotMatch(request.messages.filter((m: {role: string}) => m.role === 'system').map((m: {content: string}) => m.content).join(''), /固态电池样品测试完成/);
});

test('parses valid completion and rejects unknown response shapes', () => {
  assert.equal(parseCompletion({ choices: [{ message: { content: 'answer' } }] }), 'answer');
  for (const value of [null, {}, { choices: [] }, { choices: [{ message: { content: { text: 'bad' } } }] },
    { choices: [{ message: { content: null, tool_calls: [{ id: 'x' }] } }] },
    { choices: [{ message: { content: 'x'.repeat(64001) } }] }]) {
    assert.throws(() => parseCompletion(value), /模型/);
  }
});
