import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreData, isExcluded } from '../src/storage';

test('history and memory survive serialization; malformed saved data is never silently reset', () => {
  const data = restoreData(null);
  data.conversations.push({ id: 'c', title: 'test', createdAt: 1, updatedAt: 2, messages: [{ id: 'm', role: 'assistant', content: 'hello', createdAt: 2, sources: [{ path: 'a.md', text: 'original', mtime: 1 }] }] });
  data.activeConversationId = 'c';
  data.memories.push({ id: 'mem', conversationId: 'c', content: 'reviewed', sources: [], createdAt: 2, status: 'confirmed' });
  assert.deepEqual(restoreData(JSON.parse(JSON.stringify(data))), data);
  assert.throws(() => restoreData({ ...data, conversations: [{}] }));
  assert.throws(() => restoreData({ ...data, version: 2 }));
  assert.equal(restoreData({ ...data, activeConversationId: 'deleted' }).activeConversationId, 'c');
});

test('excluded folders use trimmed path boundaries and supported separators', () => {
  assert.equal(isExcluded('私人/日记/a.md', ' 私人/日记/ ; secrets'), true);
  assert.equal(isExcluded('私人/日记本/a.md', '私人/日记'), false);
  assert.equal(isExcluded('secrets/a.md', ' private\n secrets '), true);
});
