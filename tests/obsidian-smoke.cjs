// Run only against the disposable test-runtime/vault opened in an isolated Obsidian process.
// PLAYWRIGHT_MODULE=/path/to/playwright node tests/obsidian-smoke.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const vault = path.join(root, 'test-runtime/vault');
const requests = [];
let fail = false;
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const request = JSON.parse(body); requests.push(request);
  res.setHeader('Content-Type', 'application/json');
  if (fail) { res.statusCode = 401; res.end('{"error":"synthetic failure"}'); return; }
  const memory = request.messages[0].content.startsWith('根据提供的对话');
  const content = memory
    ? '证据：硫化物项目仍处于实验阶段 [1]。\n推断：需要客户验证。\n未知：商业订单。\n建议：跟踪界面稳定性。MEMORY_MARKER'
    : '硫化物电解质存在水敏感性与界面稳定性挑战 [1]。来源未证明商业订单。ANSWER_MARKER\n<img src=x onerror="window.BAD=true">';
  res.end(JSON.stringify({ choices: [{ message: { content } }] }));
});

async function hashes() {
  const output = {};
  for (const folder of ['research', 'private']) for (const file of await fs.readdir(path.join(vault, folder))) {
    output[`${folder}/${file}`] = createHash('sha256').update(await fs.readFile(path.join(vault, folder, file))).digest('hex');
  }
  return output;
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.connectOverCDP(process.env.OBSIDIAN_CDP || 'http://127.0.0.1:19223');
  try {
    const page = browser.contexts()[0].pages()[0];
    assert.equal(await page.evaluate(() => app.vault.adapter.basePath), vault, 'Refuse to test in a real vault');
    const before = await hashes();
    await page.evaluate(async () => { await app.plugins.disablePlugin('the-last-brain'); });
    for (const file of ['main.js', 'manifest.json', 'styles.css']) await fs.copyFile(path.join(root, file), path.join(vault, '.obsidian/plugins/the-last-brain', file));
    await page.evaluate(async port => {
      await app.plugins.enablePlugin('the-last-brain');
      const plugin = app.plugins.plugins['the-last-brain'];
      plugin.data.conversations = []; plugin.data.memories = []; plugin.data.activeConversationId = null;
      Object.assign(plugin.data.settings, { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'synthetic-test', excludedFolders: 'private', networkConsent: false });
      await plugin.save(); await plugin.openChat();
      window.readPaths = []; window.writeAttempts = [];
      const read = app.vault.cachedRead.bind(app.vault);
      app.vault.cachedRead = file => { window.readPaths.push(file.path); return read(file); };
      for (const method of ['create', 'modify', 'delete', 'rename', 'createBinary', 'modifyBinary', 'process', 'trash']) {
        app.vault[method] = (...args) => { window.writeAttempts.push(method); throw Error(`Unexpected vault write: ${method}`); };
      }
    }, server.address().port);
    await page.getByRole('textbox', { name: '输入问题' }).fill('硫化物电解质有什么风险？');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    assert.match(await page.locator('.tlb-error').innerText(), /请先在设置/);
    assert.equal(requests.length, 0);
    assert.equal(await page.getByRole('textbox', { name: '输入问题' }).inputValue(), '硫化物电解质有什么风险？');
    await page.getByRole('button', { name: '打开设置' }).click();
    assert.match(await page.locator('.modal-content').innerText(), /允许向配置的模型服务/);
    await page.locator('.modal-content .checkbox-container').click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForFunction(() => !app.plugins.plugins['the-last-brain'].busy);
    assert.equal(await page.locator('.tlb-assistant').count(), 1);
    assert.equal(await page.locator('.tlb-message-content img').count(), 0);
    assert.doesNotMatch(JSON.stringify(requests), /PRIVATE_MUST_NOT_BE_SENT/);
    assert.equal(await page.evaluate(() => window.readPaths.some(p => p.startsWith('private/'))), false);
    await page.locator('.tlb-sources summary').click();
    await page.getByRole('button', { name: '[1] research/电池.md', exact: true }).click();
    assert.equal(await page.evaluate(() => app.workspace.getActiveFile()?.path), 'research/电池.md');
    await page.evaluate(() => app.plugins.plugins['the-last-brain'].openSource('missing.md'));
    await assert.rejects(() => fs.stat(path.join(vault, 'missing.md')));
    await page.getByRole('button', { name: '整理为记忆草稿' }).click();
    await page.getByRole('button', { name: '确认记忆' }).waitFor();
    assert.match(JSON.stringify(requests.at(-1)), /ANSWER_MARKER/);
    assert.equal(await page.evaluate(() => app.plugins.plugins['the-last-brain'].data.memories[0].status), 'draft');
    await page.getByRole('button', { name: '确认记忆' }).click();
    await page.waitForFunction(() => !app.plugins.plugins['the-last-brain'].busy);
    await page.getByRole('tab', { name: '对话', exact: true }).click();
    await page.getByRole('button', { name: '新对话', exact: true }).click();
    await page.getByRole('textbox', { name: '输入问题' }).fill('硫化物后续应该跟踪什么？');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForFunction(() => !app.plugins.plugins['the-last-brain'].busy);
    assert.match(JSON.stringify(requests.at(-1)), /MEMORY_MARKER/);
    fail = true;
    await page.getByRole('textbox', { name: '输入问题' }).fill('硫化物失败重试测试');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForFunction(() => !app.plugins.plugins['the-last-brain'].busy);
    assert.match(await page.locator('.tlb-error').innerText(), /鉴权失败/);
    fail = false;
    await page.getByRole('button', { name: '重试上一个问题' }).click();
    await page.waitForFunction(() => !app.plugins.plugins['the-last-brain'].busy);
    assert.equal(await page.locator('.tlb-user').count(), 2, 'Retry must not duplicate question');
    const saved = JSON.parse(await fs.readFile(path.join(vault, '.obsidian/plugins/the-last-brain/data.json'), 'utf8'));
    assert.equal(saved.memories[0].status, 'confirmed');
    assert.equal(saved.conversations.length, 2);
    assert.equal('apiKey' in saved.settings, false);
    await page.evaluate(async () => { await app.plugins.disablePlugin('the-last-brain'); await app.plugins.enablePlugin('the-last-brain'); await app.plugins.plugins['the-last-brain'].openChat(); });
    assert.equal(await page.locator('.tlb-user').count(), 2);
    assert.equal(await page.evaluate(() => app.plugins.plugins['the-last-brain'].data.memories[0].status), 'confirmed');
    const countBefore = requests.length;
    await page.evaluate(() => { const p = app.plugins.plugins['the-last-brain']; window.originalSave = p.saveData; p.saveData = async () => { throw Error('synthetic full disk'); }; });
    await page.getByRole('textbox', { name: '输入问题' }).fill('硫化物磁盘失败测试');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForFunction(() => !app.plugins.plugins['the-last-brain'].busy);
    assert.equal(requests.length, countBefore, 'No model request after persistence failure');
    await page.evaluate(() => { app.plugins.plugins['the-last-brain'].saveData = window.originalSave; });
    await page.getByRole('button', { name: '重试上一个问题' }).click();
    await page.waitForFunction(() => !app.plugins.plugins['the-last-brain'].busy);
    await fs.mkdir(path.join(root, 'output/playwright'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'output/playwright/obsidian-chat.png') });
    await page.getByRole('tab', { name: '记忆', exact: true }).click();
    await page.screenshot({ path: path.join(root, 'output/playwright/obsidian-memory.png') });
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await page.locator('.modal').getByRole('button', { name: '删除记忆', exact: true }).click();
    await page.waitForFunction(() => !app.plugins.plugins['the-last-brain'].busy);
    assert.equal(await page.evaluate(() => app.plugins.plugins['the-last-brain'].data.memories.length), 0);
    await page.getByRole('button', { name: '删除当前对话' }).click();
    await page.locator('.modal').getByRole('button', { name: '删除对话', exact: true }).click();
    await page.waitForFunction(() => !app.plugins.plugins['the-last-brain'].busy);
    assert.equal(await page.evaluate(() => app.plugins.plugins['the-last-brain'].data.conversations.length), 1);
    assert.deepEqual(await page.evaluate(() => window.writeAttempts), []);
    assert.deepEqual(await hashes(), before, 'All note hashes unchanged');
    console.log(JSON.stringify({ passed: true, model: 'local synthetic only', requests: requests.length, noteHashesUnchanged: true, writeAttempts: 0, checks: ['native UI', 'consent', 'retrieval exclusions', 'plain text safety', 'source navigation', 'memory confirmation/reuse', 'error/retry', 'disk failure', 'history reload', 'deletion'] }, null, 2));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
