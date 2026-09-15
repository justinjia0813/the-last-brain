import { ItemView, Menu, Modal, Notice, setIcon, type WorkspaceLeaf } from 'obsidian';
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
  private theme?: 'dark' | 'light';
  private sourceDialog?: HTMLDialogElement;

  constructor(leaf: WorkspaceLeaf, host: ChatHost) { super(leaf); this.host = host; }
  getViewType(): string { return 'the-last-brain-chat'; }
  getDisplayText(): string { return 'The Last Brain'; }
  getIcon(): string { return 'brain'; }

  async onOpen(): Promise<void> {
    this.root = this.containerEl.children[1] as HTMLElement;
    this.root.empty();
    this.root.addClass('tlb-view');
    this.resizeObserver = new ResizeObserver(([entry]) => {
      const next = entry.contentRect.width < 800;
      if (next !== this.narrow) { this.narrow = next; if (next) this.sidebarOpen = false; else this.sidebarOpen = true; this.render(); }
    });
    this.resizeObserver.observe(this.root);
    this.render();
    this.root.win.requestAnimationFrame(() => { if (this.messagesEl?.isConnected) this.messagesEl.scrollTop = this.messagesEl.scrollHeight; });
  }

  async onClose(): Promise<void> { this.resizeObserver?.disconnect(); this.sourceDialog?.close(); }
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
    this.sourceDialog?.close();
    this.root.empty();
    const data = this.host.data;
    const active = data.conversations.find(c => c.id === data.activeConversationId) ?? null;
    const draftKey = active?.id ?? '__new__';
    const draft = this.composerDrafts.get(draftKey) ?? (this.composerConversationId === draftKey ? priorValue : '');

    const layout = this.root.createDiv({ cls: `tlb-layout${this.narrow ? ' is-narrow' : ''}${this.sidebarOpen ? ' sidebar-open' : ''}` });
    if (this.narrow && this.sidebarOpen) {
      const scrim = layout.createEl('button', { cls: 'tlb-scrim', attr: { 'aria-label': '关闭历史侧栏' } });
      scrim.addEventListener('click', () => { this.sidebarOpen = false; this.render(); });
    }
    const sidebar = layout.createEl('aside', { cls: 'tlb-sidebar' });
    const brand = sidebar.createDiv({ cls: 'tlb-brand' });
    brand.createEl('h1', { text: 'The Last Brain' });
    const tagline = brand.createEl('p', { text: '基于你的笔记，进行深度思考' });
    tagline.createSpan({ cls: 'tlb-badge', text: '只读' });
    const newButton = this.button(sidebar, 'plus', '新对话', 'tlb-new-button', () => {
      void this.run(async () => { await this.host.newConversation(); this.tab = 'chat'; this.sidebarOpen = !this.narrow; this.render(); this.composer?.focus(); });
    });
    newButton.disabled = this.host.busy;
    const history = sidebar.createEl('nav', { cls: 'tlb-history', attr: { 'aria-label': '对话历史' } });
    const conversations = [...data.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!conversations.length) history.createDiv({ cls: 'tlb-history-empty', text: '还没有对话' });
    let previousGroup = '';
    for (const c of conversations) {
      const date = new Date(c.updatedAt), today = new Date(), yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
      const group = date.toDateString() === today.toDateString() ? '今天' : date.toDateString() === yesterday.toDateString() ? '昨天' : '更早';
      if (group !== previousGroup) { history.createDiv({ cls: 'tlb-group-heading', text: group }); previousGroup = group; }
      const row = history.createDiv({ cls: `tlb-history-row${c.id === active?.id && this.tab === 'chat' ? ' is-active' : ''}` });
      const switcher = row.createEl('button', { cls: 'tlb-history-item', attr: { title: c.title || '新对话' } });
      switcher.createSpan({ text: c.title || '新对话' });
      switcher.createEl('time', { text: group === '今天' ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : `${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}` });
      switcher.disabled = this.host.busy;
      switcher.addEventListener('click', () => { void this.run(async () => { await this.host.selectConversation(c.id); this.tab = 'chat'; if (this.narrow) this.sidebarOpen = false; this.render(); }); });
      switcher.addEventListener('contextmenu', event => {
        event.preventDefault();
        new Menu().addItem(item => item.setTitle('删除对话').setIcon('trash-2').setDisabled(this.host.busy).onClick(() => this.confirmAction('删除对话', `删除“${c.title}”及其全部消息和关联记忆？此操作无法撤销。`, '删除对话', () => this.host.deleteConversation(c.id)))).showAtMouseEvent(event);
      });
    }
    const bottom = sidebar.createDiv({ cls: 'tlb-sidebar-bottom' });
    const memoryNav = this.button(bottom, 'database', '记忆库', `tlb-memory-nav${this.tab === 'memory' ? ' is-active' : ''}`, () => { this.tab = 'memory'; if (this.narrow) this.sidebarOpen = false; this.render(); });
    memoryNav.createSpan({ cls: 'tlb-count', text: String(data.memories.length) });
    const bottomRow = bottom.createDiv({ cls: 'tlb-bottom-row' });
    this.button(bottomRow, 'settings', '设置', 'tlb-settings-button', () => this.host.openSettings(), '打开设置');
    this.themeButton(bottomRow);
    bottom.createDiv({ cls: 'tlb-local-note', text: '对话与记忆 · 保存在此笔记库' });

    const main = layout.createEl('main', { cls: 'tlb-main' });
    const pageHead = main.createEl('header', { cls: 'tlb-main-header' });
    this.iconButton(pageHead, this.sidebarOpen ? 'panel-left-close' : 'panel-left-open', this.sidebarOpen ? '收起历史' : '展开历史', () => { this.sidebarOpen = !this.sidebarOpen; this.render(); });
    const heading = pageHead.createDiv({ cls: 'tlb-heading' });
    heading.createEl('h2', { text: this.tab === 'memory' ? '记忆库' : active?.title || '新对话' });
    const subtitle = heading.createEl('p');
    setIcon(subtitle.createSpan({ cls: 'tlb-small-icon' }), 'folder');
    subtitle.createSpan({ text: this.app.vault.getName() });
    subtitle.createSpan({ cls: 'tlb-separator', text: '/' });
    subtitle.createSpan({ text: this.tab === 'memory' ? '经你确认，才成为记忆' : '当前笔记库' });
    pageHead.createDiv({ cls: 'tlb-flex-fill' });
    if (this.narrow) this.iconButton(pageHead, 'plus', '新对话', () => { void this.run(async () => { await this.host.newConversation(); this.tab = 'chat'; this.render(); }); }).disabled = this.host.busy;
    if (!this.sidebarOpen) this.themeButton(pageHead);
    this.iconButton(pageHead, 'ellipsis', '更多选项', event => {
      const menu = new Menu();
      menu.addItem(item => item.setTitle('回到对话').setIcon('messages-square').onClick(() => { this.tab = 'chat'; this.render(); }));
      menu.addItem(item => item.setTitle('模型配置').setIcon('cpu').onClick(() => this.host.openModelSettings(this.currentTheme())));
      menu.addItem(item => item.setTitle('设置').setIcon('settings').onClick(() => this.host.openSettings()));
      if (active) menu.addItem(item => item.setTitle('删除当前对话').setIcon('trash-2').setDisabled(this.host.busy).onClick(() => this.confirmAction('删除对话', `删除“${active.title}”及其全部消息和关联记忆？此操作无法撤销。`, '删除对话', () => this.host.deleteConversation(active.id))));
      menu.showAtMouseEvent(event);
    });
    if (this.tab === 'chat') this.renderChat(main, active, draft);
    else this.renderMemories(main, data.memories);
    const status = main.createDiv({ cls: 'tlb-status', attr: { role: 'status', 'aria-live': 'polite' } });
    status.setText(this.host.status || '');
    status.toggleClass('is-empty', !this.host.status);
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

  private button(parent: HTMLElement, icon: string, text: string, cls: string, action: (event: MouseEvent) => void, label = text): HTMLButtonElement {
    const button = parent.createEl('button', { cls, attr: { 'aria-label': label, title: label, type: 'button' } });
    setIcon(button, icon); button.createSpan({ text }); button.addEventListener('click', action); return button;
  }
  private iconButton(parent: HTMLElement, icon: string, label: string, action: (event: MouseEvent) => void): HTMLButtonElement {
    const button = parent.createEl('button', { cls: 'tlb-icon-button', attr: { 'aria-label': label, title: label, type: 'button' } });
    setIcon(button, icon); button.addEventListener('click', action); return button;
  }
  private currentTheme(): 'dark' | 'light' { return this.theme ?? (this.root.doc.body.classList.contains('theme-light') ? 'light' : 'dark'); }
  private themeButton(parent: HTMLElement): void {
    const light = this.currentTheme() === 'light';
    this.iconButton(parent, light ? 'moon' : 'sun', light ? '切换深色主题' : '切换浅色主题', () => { this.theme = light ? 'dark' : 'light'; this.root.dataset.tlbTheme = this.theme; this.render(); });
  }

  private renderChat(parent: HTMLElement, active: Conversation | null, draft: string): void {
    const pane = parent.createDiv({ cls: 'tlb-chat-pane' });
    this.messagesEl = pane.createDiv({ cls: 'tlb-messages', attr: { 'aria-live': 'polite' } });
    const reading = this.messagesEl.createDiv({ cls: 'tlb-reading-column' });
    if (!active?.messages.length) {
      const welcome = reading.createDiv({ cls: 'tlb-welcome' });
      setIcon(welcome.createDiv({ cls: 'tlb-welcome-mark' }), 'sparkles');
      welcome.createEl('h2', { text: '从你的笔记，继续思考。' });
      welcome.createEl('p', { text: '找回线索、连接观点，也留住值得记住的判断。' });
      const suggestions = welcome.createDiv({ cls: 'tlb-suggestions' });
      for (const text of ['查找笔记中关于某项目毛利率的记录', '整理我对某公司的主要风险判断', '对比笔记里两种技术路线的优缺点']) {
        this.button(suggestions, 'arrow-up-right', text, 'tlb-suggestion', () => { this.composer.value = text; this.composer.dispatchEvent(new Event('input')); this.composer.focus(); });
      }
    } else active.messages.forEach(message => this.renderMessage(reading, message));
    const last = active?.messages.at(-1);
    if (last?.role === 'user' && !this.host.busy) this.button(reading, 'rotate-ccw', '重试上一个问题', 'tlb-retry', () => { void this.run(() => this.host.send(last.content)); });
    const area = pane.createDiv({ cls: 'tlb-composer-area' });
    const composer = area.createDiv({ cls: 'tlb-composer-wrap' });
    this.composer = composer.createEl('textarea', { cls: 'tlb-composer', attr: { placeholder: active?.messages.length ? '继续提问…' : '问问你的笔记…', rows: '2', 'aria-label': '输入问题' } });
    this.composer.value = draft;
    this.composerConversationId = active?.id ?? '__new__';
    this.composerDrafts.set(this.composerConversationId, draft);
    this.composer.disabled = this.host.busy;
    this.composer.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void this.send(); } });
    const actions = composer.createDiv({ cls: 'tlb-composer-actions' });
    const model = actions.createEl('button', { cls: 'tlb-model-button', attr: { 'aria-label': '配置模型', title: this.host.data.settings.model || '配置模型' } });
    model.createSpan({ text: this.host.data.settings.model || '配置模型' }); setIcon(model.createSpan({ cls: 'tlb-small-icon' }), 'chevron-down');
    model.addEventListener('click', () => this.host.openModelSettings(this.currentTheme()));
    const scope = actions.createDiv({ cls: 'tlb-scope', attr: { title: '当前版本检索此笔记库中的 Markdown 笔记；排除目录可在设置中调整。' } });
    setIcon(scope.createSpan({ cls: 'tlb-small-icon' }), 'folder'); scope.createSpan({ text: '当前笔记库' });
    actions.createDiv({ cls: 'tlb-flex-fill' });
    const send = this.iconButton(actions, this.host.busy ? 'square' : 'send', this.host.busy ? '停止后续处理' : '发送', () => { if (this.host.busy) this.host.stop(); else void this.send(); });
    send.addClass(this.host.busy ? 'tlb-stop' : 'tlb-send');
    send.title = this.host.busy ? '停止等待；服务端可能仍在处理或计费' : '发送';
    send.disabled = !this.host.busy && !draft.trim();
    this.composer.addEventListener('input', () => { this.composerDrafts.set(this.composerConversationId ?? '__new__', this.composer.value); send.disabled = !this.host.busy && !this.composer.value.trim(); });
    const hint = area.createDiv({ cls: 'tlb-composer-hint', text: 'Enter 发送 · Shift + Enter 换行' });
    hint.createSpan({ text: '回答请核对来源' });
  }

  private renderMessage(parent: HTMLElement, message: Message): void {
    const row = parent.createEl('article', { cls: `tlb-message tlb-${message.role}` });
    if (message.role === 'user') {
      row.createDiv({ cls: 'tlb-message-content tlb-user-bubble', text: message.content });
      row.createEl('time', { text: new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) });
      return;
    }
    setIcon(row.createDiv({ cls: 'tlb-assistant-avatar', attr: { 'aria-label': '笔记助手' } }), 'sparkles');
    const answer = row.createDiv({ cls: 'tlb-answer' });
    const content = answer.createDiv({ cls: 'tlb-message-content' });
    // Render text and a small set of heading conventions; never interpret HTML, images, embeds or links.
    for (const block of message.content.split(/\n\s*\n/)) {
      const lines = block.split('\n');
      for (const line of lines) {
        const heading = /^(?:#{1,3}\s+|\d+[.、]\s*)/.test(line) && line.length < 100;
        const el = content.createEl(heading ? 'h3' : 'p');
        const text = heading ? line.replace(/^#{1,3}\s+/, '').replace(/\*\*/g, '') : line;
        let from = 0;
        for (const match of text.matchAll(/\*\*(.+?)\*\*|\[(\d+)\]/g)) {
          el.appendText(text.slice(from, match.index));
          if (match[1] !== undefined) {
            el.createEl('strong', { text: match[1] });
            from = match.index! + match[0].length;
            continue;
          }
          const n = Number(match[2]);
          if (n > 0 && n <= message.sources.length) {
            const cite = el.createEl('button', { cls: 'tlb-citation', text: match[0], attr: { 'aria-label': `查看来源 ${n}` } });
            cite.addEventListener('click', () => this.openSourceDrawer(message.sources, n - 1));
          } else el.appendText(match[0]);
          from = match.index! + match[0].length;
        }
        el.appendText(text.slice(from));
      }
    }
    const actions = answer.createDiv({ cls: 'tlb-answer-actions' });
    this.renderSources(actions, message.sources);
    actions.createDiv({ cls: 'tlb-flex-fill' });
    this.button(actions, 'copy', '复制', 'tlb-text-button', () => { void this.root.win.navigator.clipboard.writeText(message.content).then(() => new Notice('已复制回答'), () => new Notice('复制失败，请选中文字复制。')); });
    const distill = this.button(actions, 'file-text', '整理记忆', 'tlb-text-button', () => { void this.distill(); }, '整理为记忆草稿');
    distill.disabled = this.host.busy;
  }

  private renderSources(parent: HTMLElement, sources: Source[]): void {
    if (!sources.length) { parent.createSpan({ cls: 'tlb-no-source', text: '未匹配到笔记来源' }); return; }
    const button = this.button(parent, 'file-text', `${sources.length} 篇来源`, 'tlb-source-trigger', () => this.openSourceDrawer(sources, 0), '查看引用来源');
    setIcon(button.createSpan({ cls: 'tlb-small-icon' }), 'chevron-right');
  }

  private openSourceDrawer(sources: Source[], initial: number): void {
    this.sourceDialog?.close(); this.sourceDialog?.remove();
    const dialog = this.root.createEl('dialog', { cls: 'tlb-source-drawer', attr: { 'aria-label': '引用来源' } });
    this.sourceDialog = dialog;
    const anchor = this.root.doc.activeElement as HTMLElement | null;
    const position = () => { const r = this.root.getBoundingClientRect(); Object.assign(dialog.style, { left: `${Math.max(r.left, r.right - 440)}px`, top: `${r.top}px`, width: `${Math.min(440,r.width)}px`, height: `${r.height}px` }); };
    const observer = new ResizeObserver(position); observer.observe(this.root);
    dialog.addEventListener('close', () => { observer.disconnect(); dialog.remove(); if (this.sourceDialog === dialog) this.sourceDialog = undefined; if (anchor?.isConnected) anchor.focus(); }, { once: true });
    dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
    const render = (index: number) => {
      dialog.empty();
      const header = dialog.createEl('header'); header.createEl('h2', { text: '引用来源' }); this.iconButton(header, 'x', '关闭引用来源', () => dialog.close());
      const nav = dialog.createDiv({ cls: 'tlb-source-nav' }); nav.createSpan({ text: `${index + 1} / ${sources.length}` });
      this.iconButton(nav, 'chevron-left', '上一篇来源', () => render(index - 1)).disabled = index === 0;
      this.iconButton(nav, 'chevron-right', '下一篇来源', () => render(index + 1)).disabled = index === sources.length - 1;
      const source = sources[index];
      dialog.createDiv({ cls: 'tlb-eyebrow', text: '引用快照 · 只读' });
      dialog.createEl('h3', { text: source.path.split('/').at(-1)?.replace(/\.md$/, '') || source.path });
      dialog.createEl('p', { cls: 'tlb-source-path', text: source.path });
      dialog.createEl('p', { cls: 'tlb-source-date', text: `笔记更新于 ${new Date(source.mtime).toLocaleString()}` });
      dialog.createEl('blockquote', { text: source.text });
      dialog.createEl('p', { cls: 'tlb-muted', text: '来源保留回答时的引用内容。笔记更新后，旧回答的引用快照不会自动变化。' });
      const list = dialog.createDiv({ cls: 'tlb-source-list' });
      sources.forEach((source, n) => { this.button(list, 'file-text', source.path.split('/').at(-1) || source.path, n === index ? 'is-active' : '', () => render(n)); });
      this.button(dialog, 'book-open', '打开原笔记', 'tlb-outlined', () => { dialog.close(); void this.run(() => this.host.openSource(source.path)); });
    };
    render(initial); position(); dialog.showModal();
  }

  private renderMemories(parent: HTMLElement, memories: Memory[]): void {
    const pane = parent.createDiv({ cls: 'tlb-memory-pane' });
    const intro = pane.createDiv({ cls: 'tlb-memory-intro' });
    setIcon(intro.createSpan(), 'database');
    intro.createEl('h2', { text: '把值得留下的，变成记忆。' });
    intro.createEl('p', { text: '草稿由对话整理，确认后才会按相关性用于后续问答。' });
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
    modal.modalEl.addClass('tlb-review-shell');
    modal.modalEl.dataset.tlbTheme = this.currentTheme();
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
    if (!this.host.error && this.host.data.memories.length > count) { this.tab = 'memory'; this.memoryFilter = 'draft'; this.render(); this.openMemoryReview(this.host.data.memories[0]); }
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
