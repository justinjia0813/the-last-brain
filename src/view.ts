import { ItemView, Modal, Notice, setIcon, type WorkspaceLeaf } from 'obsidian';
import type { ChatHost, Conversation, Memory, Message, Source } from './types';

export class ChatView extends ItemView {
  private host: ChatHost;
  private body!: HTMLElement;
  private messagesEl!: HTMLElement;
  private composer!: HTMLTextAreaElement;
  private statusEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private tab: 'chat' | 'memory' = 'chat';

  constructor(leaf: WorkspaceLeaf, host: ChatHost) {
    super(leaf);
    this.host = host;
  }

  getViewType(): string { return 'the-last-brain-chat'; }
  getDisplayText(): string { return 'The Last Brain'; }
  getIcon(): string { return 'brain'; }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('tlb-view');
    const header = root.createDiv({ cls: 'tlb-header' });
    const title = header.createDiv({ cls: 'tlb-title' });
    title.createEl('strong', { text: 'The Last Brain' });
    title.createSpan({ cls: 'tlb-readonly', text: '只读' });
    const settings = header.createEl('button', { cls: 'tlb-icon-button', attr: { 'aria-label': '打开设置', title: '设置' } });
    setIcon(settings, 'settings');
    settings.addEventListener('click', () => this.host.openSettings());

    this.body = root.createDiv({ cls: 'tlb-body' });
    this.render();
  }

  refresh(): void { this.render(); }

  private render(): void {
    if (!this.body) return;
    const draft = this.composer?.value ?? '';
    const wasFocused = document.activeElement === this.composer;
    const caret = this.composer?.selectionStart ?? draft.length;
    this.body.empty();
    const data = this.host.data;
    const active = data.conversations.find(c => c.id === data.activeConversationId) ?? null;
    const toolbar = this.body.createDiv({ cls: 'tlb-toolbar' });
    const select = toolbar.createEl('select', { cls: 'tlb-conversation-select', attr: { 'aria-label': '选择对话' } });
    if (!data.conversations.length) select.createEl('option', { text: '暂无对话', value: '' });
    for (const c of [...data.conversations].sort((a, b) => b.updatedAt - a.updatedAt)) {
      select.createEl('option', { text: c.title || '新对话', value: c.id });
    }
    select.value = active?.id ?? '';
    select.disabled = this.host.busy;
    select.addEventListener('change', () => this.run(() => this.host.selectConversation(select.value)));
    const newButton = toolbar.createEl('button', { cls: 'tlb-small-button', text: '新对话' });
    newButton.disabled = this.host.busy;
    newButton.addEventListener('click', () => this.run(() => this.host.newConversation()));
    const deleteButton = toolbar.createEl('button', { cls: 'tlb-icon-button', attr: { 'aria-label': '删除当前对话', title: '删除对话' } });
    deleteButton.disabled = this.host.busy || !active;
    setIcon(deleteButton, 'trash-2');
    deleteButton.addEventListener('click', () => {
      if (active && !this.host.busy) this.confirmAction('删除对话', `确定删除“${active.title || '新对话'}”及其全部消息和关联记忆吗？此操作无法撤销。`, '删除对话', () => this.host.deleteConversation(active.id));
    });

    const tabs = this.body.createDiv({ cls: 'tlb-tabs', attr: { role: 'tablist', 'aria-label': '内容' } });
    this.makeTab(tabs, 'chat', '对话');
    this.makeTab(tabs, 'memory', '记忆');
    if (this.tab === 'chat') this.renderChat(active);
    else this.renderMemories(data.memories);
    this.renderStatus();
    if (this.tab === 'chat' && this.composer) {
      this.composer.value = draft;
      if (wasFocused) {
        this.composer.focus();
        this.composer.setSelectionRange(caret, caret);
      }
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
  }

  private makeTab(parent: HTMLElement, tab: 'chat' | 'memory', label: string): void {
    const button = parent.createEl('button', { cls: `tlb-tab${this.tab === tab ? ' is-active' : ''}`, text: label, attr: { role: 'tab', 'aria-selected': String(this.tab === tab) } });
    button.addEventListener('click', () => { this.tab = tab; this.render(); });
  }

  private renderChat(active: Conversation | null): void {
    const pane = this.body.createDiv({ cls: 'tlb-chat-pane' });
    this.messagesEl = pane.createDiv({ cls: 'tlb-messages', attr: { 'aria-live': 'polite' } });
    if (!active?.messages.length) this.renderWelcome(this.messagesEl);
    else for (const message of active.messages) this.renderMessage(this.messagesEl, message);
    const lastUser = active?.messages.filter(m => m.role === 'user').at(-1);
    if (this.host.error && lastUser) {
      const retry = pane.createEl('button', { cls: 'tlb-retry', text: '重试上一个问题' });
      retry.addEventListener('click', () => this.run(() => this.host.send(lastUser.content)));
    }
    const form = pane.createDiv({ cls: 'tlb-composer-wrap' });
    const tools = form.createDiv({ cls: 'tlb-composer-tools' });
    tools.createSpan({ text: '只读问答' });
    const distill = tools.createEl('button', { cls: 'tlb-text-button', text: '整理为记忆草稿' });
    distill.disabled = this.host.busy || !active?.messages.length;
    distill.addEventListener('click', () => { void this.distill(); });
    this.composer = form.createEl('textarea', { cls: 'tlb-composer', attr: { placeholder: '问问你的笔记…', rows: '2', 'aria-label': '输入问题' } });
    this.composer.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void this.send(); }
    });
    const send = form.createEl('button', { cls: 'tlb-send', text: this.host.busy ? '处理中…' : '发送' });
    send.addEventListener('click', () => { void this.send(); });
    this.composer.disabled = this.host.busy;
    send.disabled = this.host.busy;
  }

  private renderWelcome(parent: HTMLElement): void {
    const welcome = parent.createDiv({ cls: 'tlb-welcome' });
    welcome.createDiv({ cls: 'tlb-welcome-mark', text: '✳' });
    welcome.createEl('h2', { text: '从你的笔记开始' });
    welcome.createEl('p', { text: '提出问题，我会检索当前知识库中的相关片段，并附上来源。' });
    const suggestions = welcome.createDiv({ cls: 'tlb-suggestions' });
    for (const text of ['查找笔记中关于某项目毛利率的记录', '整理我对某公司的主要风险判断', '对比笔记里两种技术路线的优缺点']) {
      const button = suggestions.createEl('button', { cls: 'tlb-suggestion', text });
      button.addEventListener('click', () => { this.composer.value = text; this.composer.focus(); });
    }
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

  private renderMemories(memories: Memory[]): void {
    const pane = this.body.createDiv({ cls: 'tlb-memory-pane' });
    const confirmed = memories.filter(m => m.status === 'confirmed').length;
    pane.createDiv({ cls: 'tlb-memory-heading' }).createEl('h2', { text: '记忆库' });
    pane.createEl('p', { cls: 'tlb-muted', text: `${confirmed} 条已确认记忆将按相关性用于后续问答。草稿基于近期对话和检索片段，确认后生效。` });
    if (!memories.length) pane.createEl('div', { cls: 'tlb-empty', text: '还没有记忆。可在对话后整理一份草稿。' });
    for (const memory of [...memories].sort((a, b) => b.createdAt - a.createdAt)) {
      const card = pane.createDiv({ cls: 'tlb-memory-card' });
      const meta = card.createDiv({ cls: 'tlb-memory-meta' });
      meta.createSpan({ cls: `tlb-memory-state ${memory.status}`, text: memory.status === 'confirmed' ? '已确认' : '待确认' });
      meta.createSpan({ text: new Date(memory.createdAt).toLocaleDateString() });
      card.createDiv({ cls: 'tlb-memory-content', text: memory.content });
      if (memory.sources?.length) this.renderSources(card, memory.sources);
      const actions = card.createDiv({ cls: 'tlb-memory-actions' });
      if (memory.status === 'draft') {
        const confirm = actions.createEl('button', { cls: 'tlb-small-button is-primary', text: '确认记忆' });
        confirm.disabled = this.host.busy;
        confirm.addEventListener('click', () => this.run(() => this.host.confirmMemory(memory.id)));
      }
      const remove = actions.createEl('button', { cls: 'tlb-text-button is-danger', text: '删除' });
      remove.disabled = this.host.busy;
      remove.addEventListener('click', () => {
        if (!this.host.busy) this.confirmAction('删除记忆', '确定删除这条记忆吗？此操作无法撤销。', '删除记忆', () => this.host.deleteMemory(memory.id));
      });
    }
  }

  private renderStatus(): void {
    this.statusEl = this.body.createDiv({ cls: 'tlb-status', attr: { role: 'status', 'aria-live': 'polite' } });
    this.statusEl.setText(this.host.busy ? (this.host.status || '正在处理…') : (this.host.status || '就绪'));
    this.errorEl = this.body.createDiv({ cls: `tlb-error${this.host.error ? '' : ' is-hidden'}`, attr: { role: 'alert' } });
    this.errorEl.setText(this.host.error || '');
  }

  private async send(): Promise<void> {
    const text = this.composer?.value.trim();
    if (!text || this.host.busy) return;
    const conversationId = this.host.data.activeConversationId;
    const existingIds = new Set(this.host.data.conversations.find(c => c.id === conversationId)?.messages.map(m => m.id) ?? []);
    this.composer.value = '';
    await this.run(() => this.host.send(text));
    const active = this.host.data.conversations.find(c => c.id === this.host.data.activeConversationId);
    const persisted = active?.messages.some(m => m.role === 'user' && m.content === text && !existingIds.has(m.id)) ?? false;
    if (this.host.error && !persisted && this.composer) {
      this.composer.value = text;
      this.composer.focus();
    }
  }

  private async distill(): Promise<void> {
    const count = this.host.data.memories.length;
    await this.run(() => this.host.distill());
    if (!this.host.error && this.host.data.memories.length > count) {
      this.tab = 'memory';
      this.render();
    }
  }

  private confirmAction(title: string, description: string, confirmText: string, action: () => Promise<void>): void {
    const modal = new Modal(this.app);
    modal.setTitle(title);
    modal.contentEl.createEl('p', { text: description });
    const buttons = modal.contentEl.createDiv({ cls: 'modal-button-container' });
    const cancel = buttons.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => modal.close());
    const confirm = buttons.createEl('button', { cls: 'mod-warning', text: confirmText });
    confirm.addEventListener('click', () => { modal.close(); void this.run(action); });
    modal.open();
  }

  private async run(action: () => Promise<void>): Promise<void> {
    try { await action(); }
    catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
  }
}
