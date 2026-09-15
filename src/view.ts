import { ItemView, Modal, Notice, setIcon, type WorkspaceLeaf } from 'obsidian';
import type { ChatHost, Conversation, Memory, Message, Source } from './types';

export class ChatView extends ItemView {
  private host: ChatHost;
  private root!: HTMLElement;
  private sidebarOpen = true;
  private narrow = false;
  private tab: 'chat' | 'memory' = 'chat';
  private memoryFilter: 'all' | 'draft' | 'confirmed' = 'all';
  private composerDrafts = new Map<string, string>();
  private composerConversationId: string | null = null;
  private lastRenderedConversationId: string | null = null;
  private lastRenderedMessageCount = -1;
  private composer!: HTMLTextAreaElement;
  private messagesEl!: HTMLElement;
  private resizeObserver?: ResizeObserver;

  constructor(leaf: WorkspaceLeaf, host: ChatHost) { super(leaf); this.host = host; }
  getViewType(): string { return 'the-last-brain-chat'; }
  getDisplayText(): string { return 'The Last Brain'; }
  getIcon(): string { return 'brain'; }

  async onOpen(): Promise<void> {
    this.root = this.containerEl.children[1] as HTMLElement;
    this.root.empty();
    this.root.addClass('tlb-view');
    this.resizeObserver = new ResizeObserver(([entry]) => {
      const next = entry.contentRect.width < 700;
      if (next !== this.narrow) { this.narrow = next; if (next) this.sidebarOpen = false; else this.sidebarOpen = true; this.render(); }
    });
    this.resizeObserver.observe(this.root);
    this.render();
    this.root.win.requestAnimationFrame(() => { if (this.messagesEl?.isConnected) this.messagesEl.scrollTop = this.messagesEl.scrollHeight; });
  }

  async onClose(): Promise<void> { this.resizeObserver?.disconnect(); }
  refresh(): void { this.render(); }

  private render(): void {
    if (!this.root) return;
    const priorValue = this.composer?.value ?? '';
    const focused = document.activeElement === this.composer;
    const caret = this.composer?.selectionStart ?? priorValue.length;
    const oldScrollTop = this.messagesEl?.scrollTop ?? 0;
    const oldScrollHeight = this.messagesEl?.scrollHeight ?? 0;
    const oldClientHeight = this.messagesEl?.clientHeight ?? 0;
    const wasAtBottom = oldScrollHeight - oldClientHeight - oldScrollTop < 80;
    this.root.empty();
    const data = this.host.data;
    const active = data.conversations.find(c => c.id === data.activeConversationId) ?? null;
    const draftKey = active?.id ?? '__new__';
    const draft = this.composerDrafts.get(draftKey) ?? (this.composerConversationId === draftKey ? priorValue : '');

    const header = this.root.createDiv({ cls: 'tlb-header' });
    const menu = header.createEl('button', { cls: 'tlb-icon-button', attr: { 'aria-label': this.sidebarOpen ? '收起历史' : '展开历史', title: '对话历史' } });
    setIcon(menu, this.sidebarOpen ? 'panel-left-close' : 'panel-left');
    menu.addEventListener('click', () => { this.sidebarOpen = !this.sidebarOpen; this.render(); });
    const title = header.createDiv({ cls: 'tlb-title' });
    title.createEl('strong', { text: 'The Last Brain' });
    title.createSpan({ cls: 'tlb-readonly', text: '只读问答' });
    header.createDiv({ cls: 'tlb-flex-fill' });
    const model = header.createEl('button', { cls: 'tlb-model-button', attr: { 'aria-label': '配置模型' } });
    setIcon(model, 'cpu'); model.createSpan({ text: this.host.data.settings.model || '模型设置' }); model.addEventListener('click', () => this.host.openModelSettings());
    const settings = header.createEl('button', { cls: 'tlb-icon-button', attr: { 'aria-label': '打开设置', title: '设置' } });
    setIcon(settings, 'settings'); settings.addEventListener('click', () => this.host.openSettings());

    const layout = this.root.createDiv({ cls: `tlb-layout${this.narrow ? ' is-narrow' : ''}${this.sidebarOpen ? ' sidebar-open' : ''}` });
    if (this.narrow && this.sidebarOpen) {
      const scrim = layout.createEl('button', { cls: 'tlb-scrim', attr: { 'aria-label': '关闭历史' } });
      scrim.addEventListener('click', () => { this.sidebarOpen = false; this.render(); });
    }
    const sidebar = layout.createDiv({ cls: 'tlb-sidebar' });
    const sidebarHead = sidebar.createDiv({ cls: 'tlb-sidebar-head' });
    sidebarHead.createDiv({ text: '对话历史' });
    const newButton = sidebarHead.createEl('button', { cls: 'tlb-new-button', text: '＋ 新对话', attr: { 'aria-label': '新对话' } });
    newButton.disabled = this.host.busy;
    newButton.addEventListener('click', () => this.run(async () => { await this.host.newConversation(); this.tab = 'chat'; this.sidebarOpen = !this.narrow; this.render(); }));
    const history = sidebar.createDiv({ cls: 'tlb-history', attr: { 'aria-label': '对话历史' } });
    const conversations = [...data.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!conversations.length) history.createDiv({ cls: 'tlb-muted tlb-history-empty', text: '还没有对话' });
    conversations.forEach(c => {
      const row = history.createDiv({ cls: `tlb-history-row${c.id === active?.id && this.tab === 'chat' ? ' is-active' : ''}` });
      const switcher = row.createEl('button', { cls: 'tlb-history-item', text: c.title || '新对话' });
      switcher.disabled = this.host.busy;
      switcher.addEventListener('click', () => this.run(async () => { await this.host.selectConversation(c.id); this.tab = 'chat'; if (this.narrow) this.sidebarOpen = false; this.render(); }));
      const remove = row.createEl('button', { cls: 'tlb-icon-button tlb-history-delete', attr: { 'aria-label': `删除对话 ${c.title || '新对话'}`, title: '删除对话' } });
      setIcon(remove, 'trash-2'); remove.disabled = this.host.busy;
      remove.addEventListener('click', () => this.confirmAction('删除对话', `确定删除“${c.title || '新对话'}”及其全部消息和关联记忆吗？此操作无法撤销。`, '删除对话', () => this.host.deleteConversation(c.id)));
    });
    const memoryNav = sidebar.createEl('button', { cls: `tlb-memory-nav${this.tab === 'memory' ? ' is-active' : ''}`, text: `记忆库 · ${data.memories.length}` });
    memoryNav.addEventListener('click', () => { this.tab = 'memory'; if (this.narrow) this.sidebarOpen = false; this.render(); });

    const main = layout.createDiv({ cls: 'tlb-main' });
    const pageHead = main.createDiv({ cls: 'tlb-page-head' });
    pageHead.createEl('h2', { text: this.tab === 'memory' ? '记忆库' : active?.title || '新对话' });
    pageHead.createSpan({ cls: 'tlb-muted', text: this.tab === 'memory' ? '经你确认后，才会用于后续问答' : '基于当前笔记库检索，并保留来源' });
    if (this.tab === 'memory') { const back = pageHead.createEl('button', { cls: 'tlb-back-chat', text: '回到对话' }); back.addEventListener('click', () => { this.tab = 'chat'; this.render(); }); }
    if (this.tab === 'chat') this.renderChat(main, active, draft);
    else this.renderMemories(main, data.memories);
    const status = main.createDiv({ cls: 'tlb-status', attr: { role: 'status', 'aria-live': 'polite' } });
    status.setText(this.host.busy ? (this.host.status || '正在处理…') : (this.host.status || '就绪'));
    if (this.host.error) main.createDiv({ cls: 'tlb-error', attr: { role: 'alert' }, text: this.host.error });
    if (this.tab === 'chat' && focused && this.composer) {
      this.composer.focus(); this.composer.setSelectionRange(caret, caret);
    }
    if (this.messagesEl) {
      const conversationId = active?.id ?? null;
      const count = active?.messages.length ?? 0;
      const changed = conversationId !== this.lastRenderedConversationId || count > this.lastRenderedMessageCount;
      this.messagesEl.scrollTop = changed && (wasAtBottom || this.lastRenderedMessageCount < 0 || conversationId !== this.lastRenderedConversationId) ? this.messagesEl.scrollHeight : oldScrollTop;
      this.lastRenderedConversationId = conversationId; this.lastRenderedMessageCount = count;
    }
  }

  private renderChat(parent: HTMLElement, active: Conversation | null, draft: string): void {
    const pane = parent.createDiv({ cls: 'tlb-chat-pane' });
    this.messagesEl = pane.createDiv({ cls: 'tlb-messages', attr: { 'aria-live': 'polite' } });
    if (!active?.messages.length) {
      const welcome = this.messagesEl.createDiv({ cls: 'tlb-welcome' });
      welcome.createDiv({ cls: 'tlb-welcome-mark', text: '✳' });
      welcome.createEl('h2', { text: '从你的笔记，继续思考。' });
      welcome.createEl('p', { text: '找回线索、连接观点，也留住值得记住的判断。' });
      const suggestions = welcome.createDiv({ cls: 'tlb-suggestions' });
      ['查找笔记中关于某项目毛利率的记录', '整理我对某公司的主要风险判断', '对比笔记里两种技术路线的优缺点'].forEach(text => {
        const button = suggestions.createEl('button', { cls: 'tlb-suggestion', text });
        button.addEventListener('click', () => { this.composer.value = text; this.composerDrafts.set(this.composerConversationId ?? '__new__', text); this.composer.dispatchEvent(new Event('input')); this.composer.focus(); });
      });
    } else active.messages.forEach(message => this.renderMessage(this.messagesEl, message));
    const lastUser = active?.messages.filter(m => m.role === 'user').at(-1);
    if (active?.messages.at(-1)?.role === 'user' && lastUser && !this.host.busy) {
      const retry = pane.createEl('button', { cls: 'tlb-retry', text: '重试上一个问题' });
      retry.addEventListener('click', () => this.run(() => this.host.send(lastUser.content)));
    }
    const composer = pane.createDiv({ cls: 'tlb-composer-wrap' });
    const tools = composer.createDiv({ cls: 'tlb-composer-tools' });
    tools.createSpan({ text: 'Enter 发送 · Shift + Enter 换行' });
    const distill = tools.createEl('button', { cls: 'tlb-text-button', text: '整理为记忆草稿' });
    distill.disabled = this.host.busy || !active?.messages.length;
    distill.addEventListener('click', () => void this.distill());
    this.composer = composer.createEl('textarea', { cls: 'tlb-composer', text: draft, attr: { placeholder: '问问你的笔记…', rows: '2', 'aria-label': '输入问题' } });
    this.composer.value = draft;
    this.composerConversationId = active?.id ?? '__new__';
    this.composerDrafts.set(this.composerConversationId, draft);
    this.composer.addEventListener('input', () => { this.composerDrafts.set(this.composerConversationId ?? '__new__', this.composer.value); send.disabled = this.host.busy || !this.composer.value.trim(); });
    this.composer.disabled = this.host.busy;
    this.composer.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void this.send(); } });
    const actions = composer.createDiv({ cls: 'tlb-composer-actions' });
    const model = actions.createEl('button', { cls: 'tlb-model-button', attr: { 'aria-label': '配置模型' } });
    setIcon(model, 'cpu'); model.createSpan({ text: this.host.data.settings.model || '模型设置' }); model.addEventListener('click', () => this.host.openModelSettings());
    actions.createDiv({ cls: 'tlb-flex-fill' });
    if (this.host.busy) {
      const stop = actions.createEl('button', { cls: 'tlb-stop', attr: { title: '停止当前处理；已发出的网络请求可能仍会继续', 'aria-label': '停止后续处理' } });
      setIcon(stop, 'square'); stop.createSpan({ text: '停止后续处理' }); stop.addEventListener('click', () => this.host.stop());
    }
    const send = actions.createEl('button', { cls: 'tlb-send', text: this.host.busy ? '处理中…' : '发送', attr: { 'aria-label': '发送' } });
    send.disabled = this.host.busy || !draft.trim();
    send.addEventListener('click', () => void this.send());
  }

  private renderMessage(parent: HTMLElement, message: Message): void {
    const row = parent.createDiv({ cls: `tlb-message tlb-${message.role}` });
    row.createDiv({ cls: 'tlb-message-label', text: message.role === 'user' ? '你' : '笔记助手' });
    row.createDiv({ cls: 'tlb-message-content', text: message.content });
    if (message.sources?.length) this.renderSources(row, message.sources);
  }

  private renderSources(parent: HTMLElement, sources: Source[]): void {
    const details = parent.createEl('details', { cls: 'tlb-sources' });
    details.createEl('summary', { text: `来源片段 · ${sources.length}` });
    sources.forEach((source, index) => {
      const item = details.createDiv({ cls: 'tlb-source' });
      const button = item.createEl('button', { cls: 'tlb-source-path', text: `[${index + 1}] ${source.path}` });
      button.addEventListener('click', () => this.run(() => this.host.openSource(source.path)));
      item.createEl('div', { cls: 'tlb-source-time', text: `笔记快照：${new Date(source.mtime).toLocaleString()}（可能已过时）` });
      item.createEl('p', { text: source.text });
    });
  }

  private renderMemories(parent: HTMLElement, memories: Memory[]): void {
    const pane = parent.createDiv({ cls: 'tlb-memory-pane' });
    const filters = pane.createDiv({ cls: 'tlb-memory-filters', attr: { role: 'tablist', 'aria-label': '记忆筛选' } });
    const labels = { all: '全部', draft: '待确认', confirmed: '已确认' };
    (['all', 'draft', 'confirmed'] as const).forEach(key => {
      const count = memories.filter(m => key === 'all' || m.status === key).length;
      const button = filters.createEl('button', { cls: `tlb-tab${this.memoryFilter === key ? ' is-active' : ''}`, text: `${labels[key]} ${count}`, attr: { role: 'tab', 'aria-selected': String(this.memoryFilter === key) } });
      button.addEventListener('click', () => { this.memoryFilter = key; this.render(); });
    });
    const filtered = [...memories].filter(m => this.memoryFilter === 'all' || m.status === this.memoryFilter).sort((a, b) => b.createdAt - a.createdAt);
    if (!filtered.length) pane.createDiv({ cls: 'tlb-empty', text: this.memoryFilter === 'all' ? '还没有记忆。可在对话后整理一份草稿。' : `这里还没有${labels[this.memoryFilter]}。` });
    filtered.forEach(memory => {
      const card = pane.createDiv({ cls: 'tlb-memory-card' });
      const meta = card.createDiv({ cls: 'tlb-memory-meta' });
      meta.createSpan({ cls: `tlb-memory-state ${memory.status}`, text: memory.status === 'confirmed' ? '已确认' : '待确认' });
      meta.createSpan({ text: new Date(memory.createdAt).toLocaleDateString() });
      card.createDiv({ cls: 'tlb-memory-content', text: memory.content });
      if (memory.sources?.length) this.renderSources(card, memory.sources);
      const actions = card.createDiv({ cls: 'tlb-memory-actions' });
      const review = actions.createEl('button', { cls: 'tlb-small-button', text: memory.status === 'draft' ? '审阅与编辑' : '编辑记忆' });
      review.addEventListener('click', () => this.openMemoryReview(memory));
      if (memory.status === 'draft') {
        const confirm = actions.createEl('button', { cls: 'tlb-small-button is-primary', text: '确认记忆', attr: { 'aria-label': '确认记忆' } });
        confirm.disabled = this.host.busy;
        confirm.addEventListener('click', () => this.run(() => this.host.confirmMemory(memory.id)));
      }
      const remove = actions.createEl('button', { cls: 'tlb-text-button is-danger', text: '删除' });
      remove.disabled = this.host.busy;
      remove.addEventListener('click', () => this.confirmAction('删除记忆', '确定删除这条记忆吗？此操作无法撤销。', '删除记忆', () => this.host.deleteMemory(memory.id)));
    });
  }

  private openMemoryReview(memory: Memory): void {
    const modal = new Modal(this.app);
    modal.setTitle(memory.status === 'draft' ? '审阅记忆草稿' : '编辑记忆');
    modal.contentEl.addClass('tlb-review-modal');
    modal.contentEl.createEl('p', { text: memory.status === 'draft' ? '确认后，这条记忆才会用于后续问答。' : '保存后更新这条记忆。' });
    const editor = modal.contentEl.createEl('textarea', { cls: 'tlb-memory-editor', attr: { 'aria-label': '记忆内容', rows: '10' } });
    editor.value = memory.content;
    const actions = modal.contentEl.createDiv({ cls: 'modal-button-container' });
    const close = actions.createEl('button', { text: '取消' }); close.addEventListener('click', () => modal.close());
    if (memory.status === 'draft') {
      const save = actions.createEl('button', { text: '保存草稿' });
      save.addEventListener('click', () => { void this.saveMemory(memory, editor.value, false, modal, save); });
    }
    const confirm = actions.createEl('button', { cls: 'mod-cta', text: memory.status === 'draft' ? '保存并确认' : '保存修改' });
    confirm.addEventListener('click', () => { void this.saveMemory(memory, editor.value, true, modal, confirm); });
    modal.open();
  }

  private async saveMemory(memory: Memory, content: string, confirm: boolean, modal: Modal, button: HTMLButtonElement): Promise<void> {
    if (!content.trim() || this.host.busy) return;
    button.disabled = true;
    try { await this.host.updateMemory(memory.id, content.trim(), confirm); modal.close(); }
    catch (error) { new Notice(error instanceof Error ? error.message : String(error)); button.disabled = false; }
  }

  private async send(): Promise<void> {
    const text = this.composer?.value.trim();
    if (!text || this.host.busy) return;
    const existingIds = new Set(this.host.data.conversations.find(c => c.id === this.host.data.activeConversationId)?.messages.map(m => m.id) ?? []);
    this.composer.value = '';
    const conversationId = this.host.data.activeConversationId;
    this.composerDrafts.set(conversationId ?? '__new__', '');
    await this.run(() => this.host.send(text));
    const active = this.host.data.conversations.find(c => c.id === this.host.data.activeConversationId);
    const persisted = active?.messages.some(m => m.role === 'user' && m.content === text && !existingIds.has(m.id)) ?? false;
    if (this.host.error && !persisted && this.composer) { this.composer.value = text; this.composerDrafts.set(conversationId ?? '__new__', text); this.composer.dispatchEvent(new Event('input')); this.composer.focus(); }
  }

  private async distill(): Promise<void> {
    const count = this.host.data.memories.length;
    await this.run(() => this.host.distill());
    if (!this.host.error && this.host.data.memories.length > count) { this.tab = 'memory'; this.memoryFilter = 'draft'; this.render(); }
  }

  private confirmAction(title: string, description: string, confirmText: string, action: () => Promise<void>): void {
    const modal = new Modal(this.app); modal.setTitle(title); modal.contentEl.createEl('p', { text: description });
    const buttons = modal.contentEl.createDiv({ cls: 'modal-button-container' });
    buttons.createEl('button', { text: '取消' }).addEventListener('click', () => modal.close());
    buttons.createEl('button', { cls: 'mod-warning', text: confirmText }).addEventListener('click', () => { modal.close(); void this.run(action); });
    modal.open();
  }
  private async run(action: () => Promise<void>): Promise<void> {
    try { await action(); } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
  }
}
