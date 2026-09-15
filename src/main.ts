import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl } from 'obsidian';
import { ChatView } from './view';
import { retrieve } from './retrieval';
import { buildRequest, parseCompletion } from './model';
import { DEFAULT_SETTINGS, type ChatHost, type PluginData, type Note, type Source } from './types';
import { restoreData, isExcluded } from './storage';

const VIEW = 'the-last-brain-chat';
const id = () => crypto.randomUUID();

export default class LastBrainPlugin extends Plugin implements ChatHost {
  data: PluginData = restoreData(null);
  busy = false;
  status = '';
  error = '';
  private saves: Promise<void> = Promise.resolve();
  private alive = true;

  async onload() {
    try { this.data = restoreData(await this.loadData()); }
    catch { new Notice('The Last Brain 数据无法读取，已停止加载以保护历史。请先备份并检查插件 data.json。', 0); return; }
    this.registerView(VIEW, leaf => new ChatView(leaf, this));
    this.addRibbonIcon('messages-square', 'The Last Brain · 只读问答', () => { void this.openChat(); });
    this.addCommand({ id: 'open-chat', name: '打开只读问答', callback: () => { void this.openChat(); } });
    this.addSettingTab(new BrainSettings(this.app, this));
  }

  onunload() { this.alive = false; }

  async openChat() {
    try {
      const leaf = this.app.workspace.getLeavesOfType(VIEW)[0] ?? this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW, active: true });
      await this.app.workspace.revealLeaf(leaf);
    } catch { new Notice('无法打开聊天面板，请重试。'); }
  }

  refresh() {
    if (!this.alive) return;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) if (leaf.view instanceof ChatView) leaf.view.refresh();
  }

  save(): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(this.data));
    const next = this.saves.catch(() => {}).then(() => this.saveData(snapshot));
    this.saves = next;
    return next;
  }

  private async change(fn: () => void) {
    if (this.busy) return;
    const before = structuredClone(this.data);
    this.busy = true;
    try { fn(); await this.save(); this.error = ''; }
    catch { this.data = before; this.error = '本地保存失败，变更未保留。请检查磁盘空间后重试。'; }
    finally { this.busy = false; this.refresh(); }
  }

  async newConversation() {
    await this.change(() => {
      const conversation = { id: id(), title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
      this.data.conversations.unshift(conversation);
      this.data.activeConversationId = conversation.id;
    });
  }

  async selectConversation(conversationId: string) {
    await this.change(() => { if (this.data.conversations.some(c => c.id === conversationId)) this.data.activeConversationId = conversationId; });
  }

  async deleteConversation(conversationId: string) {
    await this.change(() => {
      this.data.conversations = this.data.conversations.filter(c => c.id !== conversationId);
      this.data.memories = this.data.memories.filter(m => m.conversationId !== conversationId);
      if (this.data.activeConversationId === conversationId) this.data.activeConversationId = this.data.conversations[0]?.id ?? null;
    });
  }

  async confirmMemory(memoryId: string) { await this.change(() => { const memory = this.data.memories.find(m => m.id === memoryId); if (memory) memory.status = 'confirmed'; }); }
  async deleteMemory(memoryId: string) { await this.change(() => { this.data.memories = this.data.memories.filter(m => m.id !== memoryId); }); }

  async openSource(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== 'md') { new Notice('来源笔记已移动或删除。'); return; }
    // Open existing files only: openLinkText could create a missing note.
    await this.app.workspace.getLeaf('tab').openFile(file, { active: true, state: { mode: 'preview' } });
  }

  openSettings() { new SettingsModal(this.app, this).open(); }

  private async readSources(query: string, settings = this.data.settings) {
    const notes: Note[] = [];
    let skipped = 0;
    let bytes = 0;
    // ponytail: rescan up to 20 MB per request; add an incremental cache if real vault latency warrants it.
    const files = this.app.vault.getMarkdownFiles().filter(f => !isExcluded(f.path, settings.excludedFolders)).sort((a, b) => a.path.localeCompare(b.path));
    for (const file of files) {
      if (file.stat.size > 1_000_000 || bytes + file.stat.size > 20_000_000) { skipped++; continue; }
      bytes += file.stat.size;
      try { notes.push({ path: file.path, text: await this.app.vault.cachedRead(file), mtime: file.stat.mtime }); }
      catch { skipped++; }
    }
    const result = retrieve(notes, query, settings);
    result.skipped += skipped;
    return result;
  }

  async send(text: string) { await this.run('chat', text.trim()); }
  async distill() { await this.run('memory', ''); }

  private async run(mode: 'chat' | 'memory', text: string) {
    if (this.busy || !this.alive || (mode === 'chat' && !text)) return;
    if (text.length > 12000) { this.error = '问题过长，请缩短到 12,000 字以内。'; this.refresh(); return; }
    if (!this.data.settings.networkConsent) { this.error = '请先在设置中确认：提问会将问题、近期对话、相关笔记片段和记忆发送到你配置的模型服务。'; this.refresh(); return; }
    let conversation = this.data.conversations.find(c => c.id === this.data.activeConversationId);
    if (mode === 'memory' && !conversation?.messages.some(m => m.role === 'assistant')) { this.error = '先完成一轮问答，再沉淀记忆。'; this.refresh(); return; }
    this.busy = true; this.error = ''; this.status = '正在检索当前笔记库…'; this.refresh();
    try {
      const settings = { ...this.data.settings };
      const apiKey = this.app.secretStorage.getSecret(settings.secretName) ?? '';
      // Validate connection configuration before saving a user message.
      buildRequest({ settings, apiKey, messages: [], sources: [], memories: [], mode });
      if (!conversation) {
        conversation = { id: id(), title: text.slice(0, 36), createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
        this.data.conversations.unshift(conversation); this.data.activeConversationId = conversation.id;
      }
      if (mode === 'chat') {
        const last = conversation.messages.at(-1);
        if (!(last?.role === 'user' && last.content === text)) conversation.messages.push({ id: id(), role: 'user', content: text, createdAt: Date.now(), sources: [] });
        if (conversation.messages.length === 1) conversation.title = text.slice(0, 36);
        conversation.updatedAt = Date.now();
        await this.save();
      }
      const query = conversation.messages.filter(m => m.role === 'user').slice(-3).map(m => m.content).join('\n').slice(-12000);
      const result = await this.readSources(query, settings);
      if (!this.alive) return;
      this.status = `已检索 ${result.scanned} 篇 · 引用 ${result.sources.length} 个片段${result.skipped ? ` · 跳过 ${result.skipped} 篇（大小限制或读取失败）` : ''} · 等待模型回答…`;
      this.refresh();
      // Exclusions apply to old excerpts as well as newly read files.
      const allowed = (source: Source) => !isExcluded(source.path, settings.excludedFolders);
      const messages = conversation.messages.map(message => ({ ...message, sources: message.sources.filter(allowed) }));
      const memories = this.data.memories.filter(memory => memory.sources.every(allowed));
      const request = buildRequest({ settings, apiKey, messages, sources: result.sources, memories, mode });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let response;
      try {
        response = await Promise.race([
          requestUrl({ ...request, method: 'POST', throw: false }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('等待模型超时（90 秒），请稍后重试。')), 90000); }),
        ]);
      } finally { clearTimeout(timer); }
      if (!this.alive) return;
      if (response.status < 200 || response.status >= 300) throw new Error(response.status === 401 || response.status === 403 ? '模型鉴权失败，请检查密钥和模型权限。' : response.status === 429 ? '模型服务限流或额度不足，请稍后重试。' : `模型服务返回错误（${response.status}），请检查服务地址及模型名称。`);
      const answer = parseCompletion(response.json);
      const before = structuredClone(this.data);
      if (mode === 'chat') conversation.messages.push({ id: id(), role: 'assistant', content: answer, createdAt: Date.now(), sources: result.sources });
      else this.data.memories.unshift({ id: id(), conversationId: conversation.id, content: answer, sources: result.sources, createdAt: Date.now(), status: 'draft' });
      conversation.updatedAt = Date.now();
      try { await this.save(); }
      catch { this.data = before; throw new Error('回答已生成但本地保存失败，请检查磁盘后重试。'); }
      this.status = `已检索 ${result.scanned} 篇 · 引用 ${result.sources.length} 个片段${result.skipped ? ` · 跳过 ${result.skipped} 篇（大小限制或读取失败）` : ''}${result.sources.length ? '' : ' · 未找到匹配笔记，回答缺少笔记依据'}${mode === 'memory' ? ' · 记忆草稿待确认' : ''}`;
    } catch (error) {
      // Do not surface request payloads, provider response bodies, or secrets in errors.
      this.error = error instanceof Error && /^(请|模型|等待模型|回答|服务|不支持|无效|API|Base|模型名称)/.test(error.message) ? error.message : '请求或本地保存失败。请检查服务配置、网络和磁盘空间后重试。';
      this.status = '';
    } finally { this.busy = false; this.refresh(); }
  }
}

import { Modal } from 'obsidian';
class SettingsModal extends Modal {
  constructor(app: App, private plugin: LastBrainPlugin) { super(app); }
  onOpen() { this.titleEl.setText('The Last Brain 设置'); renderSettings(this.contentEl, this.plugin); }
  onClose() { this.contentEl.empty(); }
}
class BrainSettings extends PluginSettingTab {
  constructor(app: App, private brain: LastBrainPlugin) { super(app, brain); }
  display() { this.containerEl.empty(); renderSettings(this.containerEl, this.brain); }
}
function renderSettings(container: HTMLElement, plugin: LastBrainPlugin) {
  container.createEl('p', { text: '对当前笔记库只读；对话与记忆保存在插件自身数据中。当前版本检索 Markdown 笔记。' });
  const persist = async () => { try { await plugin.save(); plugin.refresh(); } catch { new Notice('设置保存失败，请检查磁盘空间。'); } };
  new Setting(container).setName('模型服务地址').setDesc('填写兼容接口根地址，例如 https://api.openai.com/v1 或 http://localhost:11434/v1。').addText(t => t.setValue(plugin.data.settings.baseUrl).setPlaceholder(DEFAULT_SETTINGS.baseUrl).onChange(async value => { plugin.data.settings.baseUrl = value.trim(); await persist(); }));
  new Setting(container).setName('模型名称').setDesc('填写服务商提供的完整模型名。').addText(t => t.setValue(plugin.data.settings.model).setPlaceholder('例如你的服务商模型 ID').onChange(async value => { plugin.data.settings.model = value.trim(); await persist(); }));
  new Setting(container).setName('密钥存储名称').setDesc('仅用小写字母、数字和短横线；密钥由 Obsidian 管理，不写入本插件的对话数据。').addText(t => t.setValue(plugin.data.settings.secretName).onChange(async value => { const name = value.trim(); if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return; plugin.data.settings.secretName = name; await persist(); }));
  let newKey = '';
  new Setting(container).setName('更新服务密钥').setDesc('输入后点击保存。本地无鉴权服务可不设置。').addText(t => { t.inputEl.type = 'password'; t.inputEl.autocomplete = 'off'; t.setPlaceholder('输入新密钥').onChange(value => { newKey = value.trim(); }); }).addButton(b => b.setButtonText('保存密钥').onClick(() => {
    if (!newKey) { new Notice('请先输入密钥。'); return; }
    try { plugin.app.secretStorage.setSecret(plugin.data.settings.secretName, newKey); new Notice('密钥已保存到 Obsidian。'); }
    catch { new Notice('密钥保存失败，请检查存储名称。'); }
  }));
  new Setting(container).setName('清除已保存密钥').addButton(b => b.setButtonText('清除密钥').onClick(() => { plugin.app.secretStorage.setSecret(plugin.data.settings.secretName, ''); new Notice('已清除当前名称的密钥。'); }));
  new Setting(container).setName('排除目录').setDesc('每行一个路径，例如 私人/日记。不读取这些目录；历史对话中已发送的内容不会自动撤回，调整后请新建对话。').addTextArea(t => t.setValue(plugin.data.settings.excludedFolders).onChange(async value => { plugin.data.settings.excludedFolders = value; await persist(); }));
  new Setting(container).setName('最多引用片段').addDropdown(d => { for (const n of [3, 6, 10]) d.addOption(String(n), String(n)); d.setValue(String(plugin.data.settings.maxSources)).onChange(async value => { plugin.data.settings.maxSources = Number(value); await persist(); }); });
  new Setting(container).setName('每次笔记上下文上限').setDesc('以字符数计；首版单文件最多 1 MB、每次读取最多 20 MB，跳过数量会显示。').addDropdown(d => { for (const n of [8000, 16000, 32000]) d.addOption(String(n), `${n.toLocaleString()} 字符`); d.setValue(String(plugin.data.settings.contextChars)).onChange(async value => { plugin.data.settings.contextChars = Number(value); await persist(); }); });
  new Setting(container).setName('允许向配置的模型服务发送上下文').setDesc('仅在点击发送或沉淀记忆时传输问题、近期对话、相关笔记片段和确认记忆。可能按服务商规则计费。关闭后停止发起新请求。').addToggle(t => t.setValue(plugin.data.settings.networkConsent).onChange(async value => { plugin.data.settings.networkConsent = value; await persist(); }));
}
