import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl } from 'obsidian';
import { ChatView } from './view';
import { createRetriever } from './retrieval';
import { buildRequest, parseCompletion } from './model';
import { ModelSettingsModal } from './model-settings';
import { type ChatHost, type PluginData, type Source } from './types';
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
  private operation?: { cancelled: boolean; cancelWait?: () => void };

  async onload() {
    try { this.data = restoreData(await this.loadData()); }
    catch { new Notice('The Last Brain 数据无法读取，已停止加载以保护历史。请先备份并检查插件 data.json。', 0); return; }
    this.registerView(VIEW, leaf => new ChatView(leaf, this));
    this.addRibbonIcon('messages-square', 'The Last Brain · 只读问答', () => { void this.openChat(); });
    this.addCommand({ id: 'open-chat', name: '打开只读问答', callback: () => { void this.openChat(); } });
    this.addSettingTab(new BrainSettings(this.app, this));
  }

  onunload() { this.alive = false; this.stop(); }

  async openChat() {
    try {
      const existing = this.app.workspace.getLeavesOfType(VIEW);
      const leaf = existing.find(item => item.getRoot() === this.app.workspace.rootSplit) ?? this.app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW, active: true });
      await this.app.workspace.revealLeaf(leaf);
      for (const old of existing) if (old !== leaf && old.getRoot() !== this.app.workspace.rootSplit) old.detach();
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

  async updateMemory(memoryId: string, content: string, confirm: boolean) {
    const text = content.trim();
    if (!text || text.length > 64000) throw new Error('记忆内容须为 1–64,000 个字符。');
    if (this.busy) throw new Error('正在处理，请稍后保存记忆。');
    await this.change(() => {
      const memory = this.data.memories.find(m => m.id === memoryId);
      if (!memory) throw new Error('记忆已不存在。');
      memory.content = text;
      memory.status = confirm ? 'confirmed' : 'draft';
    });
    if (this.error) throw new Error(this.error);
  }

  stop() {
    if (!this.operation) return;
    this.operation.cancelled = true;
    this.operation.cancelWait?.();
    this.status = '正在停止等待…';
    this.refresh();
  }

  async confirmMemory(memoryId: string) { await this.change(() => { const memory = this.data.memories.find(m => m.id === memoryId); if (memory) memory.status = 'confirmed'; }); }
  async deleteMemory(memoryId: string) { await this.change(() => { this.data.memories = this.data.memories.filter(m => m.id !== memoryId); }); }

  async openSource(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== 'md') { new Notice('来源笔记已移动或删除。'); return; }
    // Open existing files only: openLinkText could create a missing note.
    await this.app.workspace.getLeaf('tab').openFile(file, { active: true, state: { mode: 'preview' } });
  }

  openModelSettings(theme?: 'dark' | 'light') { const modal = new ModelSettingsModal(this.app, this); if (theme) modal.modalEl.dataset.tlbTheme = theme; modal.open(); }

  openSettings() { new SettingsModal(this.app, this).open(); }

  private async readSources(query: string, settings = this.data.settings, cancelled = () => false) {
    const retriever = createRetriever(query, settings);
    const allFiles = this.app.vault.getMarkdownFiles();
    const files = allFiles.filter(f => !isExcluded(f.path, settings.excludedFolders));
    const excluded = allFiles.length - files.length;
    let failed = 0, lastProgress = 0;
    // ponytail: reuse Obsidian's read cache and scan one note at a time; add a persistent index only if measured latency warrants it.
    for (let i = 0; i < files.length; i++) {
      if (cancelled()) break;
      const file = files[i];
      let text: string | undefined;
      try { text = await this.app.vault.cachedRead(file); }
      catch { failed++; }
      if (cancelled()) break;
      if (text !== undefined) retriever.add({ path: file.path, text, mtime: file.stat.mtime });
      if (i % 25 === 24) {
        if (Date.now() - lastProgress > 200) {
          this.status = `正在检索当前笔记库… ${i + 1} / ${files.length} 篇`;
          this.refresh(); lastProgress = Date.now();
        }
        // Yield to the interface so stopping and resizing remain responsive during a full-vault scan.
        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      }
    }
    return { ...retriever.finish(), excluded, failed };
  }

  async send(text: string) { await this.run('chat', text.trim()); }
  async distill() { await this.run('memory', ''); }

  private async run(mode: 'chat' | 'memory', text: string) {
    if (this.busy || !this.alive || (mode === 'chat' && !text)) return;
    if (text.length > 12000) { this.error = '问题过长，请缩短到 12,000 字以内。'; this.refresh(); return; }
    if (!this.data.settings.networkConsent) { this.error = '请先在设置中确认：提问会将问题、近期对话、相关笔记片段和记忆发送到你配置的模型服务。'; this.refresh(); return; }
    let conversation = this.data.conversations.find(c => c.id === this.data.activeConversationId);
    if (mode === 'memory' && !conversation?.messages.some(m => m.role === 'assistant')) { this.error = '先完成一轮问答，再沉淀记忆。'; this.refresh(); return; }
    const operation = { cancelled: false } as { cancelled: boolean; cancelWait?: () => void };
    this.operation = operation;
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
      if (operation.cancelled || !this.alive) return;
      const query = conversation.messages.filter(m => m.role === 'user').slice(-3).map(m => m.content).join('\n').slice(-12000);
      const result = await this.readSources(query, settings, () => operation.cancelled || !this.alive);
      if (!this.alive || operation.cancelled) return;
      const coverage = `已检索 ${result.scanned} 篇 · 引用 ${result.sources.length} 个片段${result.excluded ? ` · 已排除 ${result.excluded} 篇` : ''}${result.failed ? ` · 读取失败 ${result.failed} 篇` : ''}`;
      this.status = `${coverage} · 等待模型回答…`;
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
          new Promise<never>((_, reject) => { operation.cancelWait = () => reject(new Error('stopped')); }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('等待模型超时（90 秒），请稍后重试。')), 90000); }),
        ]);
      } finally { clearTimeout(timer); }
      if (!this.alive || operation.cancelled) return;
      if (response.status < 200 || response.status >= 300) throw new Error(response.status === 401 || response.status === 403 ? '模型鉴权失败，请检查密钥和模型权限。' : response.status === 429 ? '模型服务限流或额度不足，请稍后重试。' : `模型服务返回错误（${response.status}），请检查服务地址及模型名称。`);
      const answer = parseCompletion(response.json);
      this.operation = undefined; // The accepted result is now being saved; do not interrupt persistence.
      const before = structuredClone(this.data);
      if (mode === 'chat') conversation.messages.push({ id: id(), role: 'assistant', content: answer, createdAt: Date.now(), sources: result.sources });
      else this.data.memories.unshift({ id: id(), conversationId: conversation.id, content: answer, sources: result.sources, createdAt: Date.now(), status: 'draft' });
      conversation.updatedAt = Date.now();
      try { await this.save(); }
      catch { this.data = before; throw new Error('回答已生成但本地保存失败，请检查磁盘后重试。'); }
      this.status = `${coverage}${result.sources.length ? '' : ' · 未找到匹配笔记，回答缺少笔记依据'}${mode === 'memory' ? ' · 记忆草稿待确认' : ''}`;
    } catch (error) {
      if (operation.cancelled) return;
      // Do not surface request payloads, provider response bodies, or secrets in errors.
      this.error = error instanceof Error && /^(请|模型|等待模型|回答|服务|不支持|无效|API|Base|模型名称)/.test(error.message) ? error.message : '请求或本地保存失败。请检查服务配置、网络和磁盘空间后重试。';
      this.status = '';
    } finally {
      if (operation.cancelled) { this.error = ''; this.status = '已停止等待。服务端可能仍在处理或计费，迟到的回答不会保存。'; }
      this.operation = undefined; this.busy = false; this.refresh();
    }
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
  new Setting(container).setName('模型配置').setDesc(plugin.data.settings.model || '选择服务并配置模型，密钥由 Obsidian 保存。').addButton(b => b.setButtonText('配置模型').onClick(() => plugin.openModelSettings()));
  new Setting(container).setName('排除目录').setDesc('每行一个路径，例如 私人/日记。不读取这些目录；历史对话中已发送的内容不会自动撤回，调整后请新建对话。').addTextArea(t => t.setValue(plugin.data.settings.excludedFolders).onChange(async value => { plugin.data.settings.excludedFolders = value; await persist(); }));
  new Setting(container).setName('最多引用片段').addDropdown(d => { for (const n of [3, 6, 10]) d.addOption(String(n), String(n)); d.setValue(String(plugin.data.settings.maxSources)).onChange(async value => { plugin.data.settings.maxSources = Number(value); await persist(); }); });
  new Setting(container).setName('每次笔记上下文上限').setDesc('仅限制发送给模型的笔记片段总字符数；本地检索覆盖全部未排除的 Markdown 笔记，不按文件大小截断。').addDropdown(d => { for (const n of [8000, 16000, 32000]) d.addOption(String(n), `${n.toLocaleString()} 字符`); d.setValue(String(plugin.data.settings.contextChars)).onChange(async value => { plugin.data.settings.contextChars = Number(value); await persist(); }); });
  new Setting(container).setName('允许向配置的模型服务发送上下文').setDesc('仅在点击发送或沉淀记忆时传输问题、近期对话、相关笔记片段和确认记忆。可能按服务商规则计费。关闭后停止发起新请求。').addToggle(t => t.setValue(plugin.data.settings.networkConsent).onChange(async value => { plugin.data.settings.networkConsent = value; await persist(); }));
}
