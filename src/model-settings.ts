import { App, Modal, requestUrl } from 'obsidian';
import { buildRequest, parseCompletion } from './model';
import type { PluginData, Settings } from './types';

type SettingsPlugin = {
  data: PluginData;
  busy: boolean;
  save(): Promise<void>;
  refresh(): void;
};

type Provider = 'openai' | 'deepseek' | 'ollama' | 'custom';
type ProviderDraft = { baseUrl: string; model: string; secretName: string; identityUrl: string; typedKey: string };
const providers: Record<Provider, { label: string; url: string; cloud: boolean }> = {
  openai: { label: 'OpenAI', url: 'https://api.openai.com/v1', cloud: true },
  deepseek: { label: 'DeepSeek', url: 'https://api.deepseek.com', cloud: true },
  ollama: { label: 'Ollama（本地）', url: 'http://localhost:11434/v1', cloud: false },
  custom: { label: '自定义兼容服务', url: '', cloud: false },
};

const clone = (settings: Settings): Settings => ({ ...settings });
const cleanUrl = (value: string) => value.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');

function detectProvider(url: string): Provider {
  const clean = cleanUrl(url).toLowerCase();
  return (Object.keys(providers) as Provider[]).find(id => providers[id].url && clean === providers[id].url.toLowerCase()) ?? 'custom';
}

export class ModelSettingsModal extends Modal {
  private original: Settings;
  private draft: Settings;
  private provider: Provider;
  private providerDrafts = new Map<Provider, ProviderDraft>();
  private typedKey = '';
  private revealKey = false;
  private secretIdentityUrl: string;
  private saving = false;
  private revision = 0;
  private closed = false;
  private message?: HTMLElement;
  private testButton?: HTMLButtonElement;
  private keyInput?: HTMLInputElement;
  private urlInput?: HTMLInputElement;
  private modelInput?: HTMLInputElement;
  private keyRow?: HTMLElement;
  private controlsRoot?: HTMLElement;

  constructor(app: App, private plugin: SettingsPlugin) {
    super(app);
    this.original = clone(plugin.data.settings);
    this.draft = clone(this.original);
    this.provider = detectProvider(this.draft.baseUrl);
    this.secretIdentityUrl = cleanUrl(this.draft.baseUrl);
    this.providerDrafts.set(this.provider, this.captureProviderDraft());
  }

  onOpen() {
    this.modalEl.addClass('tlb-model-modal');
    this.titleEl.setText('模型服务设置');
    const root = this.contentEl.createDiv({ cls: 'tlb-model-settings' });
    this.controlsRoot = root;
    root.createEl('p', { text: '设置仅在点击保存后生效。连接测试会向所选服务发送一条固定的测试问候语，可能产生服务费用；请求最长等待 15 秒。' });

    const providerRow = root.createDiv({ cls: 'tlb-model-field' });
    providerRow.createEl('label', { text: '服务提供方', attr: { for: 'tlb-provider' } });
    const select = providerRow.createEl('select', { attr: { id: 'tlb-provider' } });
    (Object.keys(providers) as Provider[]).forEach(id => select.createEl('option', { text: providers[id].label, value: id }));
    select.value = this.provider;
    select.addEventListener('change', () => this.changeProvider(select.value as Provider));

    const modelRow = root.createDiv({ cls: 'tlb-model-field' });
    modelRow.createEl('label', { text: '模型名称', attr: { for: 'tlb-model' } });
    this.modelInput = modelRow.createEl('input', { type: 'text', attr: { id: 'tlb-model', placeholder: '填写服务支持的模型名称', autocomplete: 'off' } });
    this.modelInput.value = this.draft.model;
    this.modelInput.addEventListener('input', () => { this.draft.model = this.modelInput!.value; this.edited(); });

    const urlRow = root.createDiv({ cls: 'tlb-model-field' });
    urlRow.createEl('label', { text: '服务地址', attr: { for: 'tlb-url' } });
    this.urlInput = urlRow.createEl('input', { type: 'url', attr: { id: 'tlb-url', placeholder: 'https://example.com/v1', autocomplete: 'url' } });
    this.urlInput.value = this.draft.baseUrl;
    this.urlInput.addEventListener('input', () => {
      const previousUrl = cleanUrl(this.draft.baseUrl);
      this.draft.baseUrl = this.urlInput!.value;
      if (cleanUrl(this.draft.baseUrl) !== previousUrl && this.typedKey) {
        this.typedKey = '';
        this.keyInput!.value = '';
      }
      this.edited();
      this.renderKeyState();
    });
    this.urlInput.addEventListener('blur', () => { this.syncSecretIdentity(); this.renderKeyState(); });

    const keyRow = root.createDiv({ cls: 'tlb-model-field' });
    this.keyRow = keyRow;
    keyRow.createEl('label', { text: providers[this.provider].cloud ? '服务密钥' : '服务密钥（可选）', attr: { for: 'tlb-key' } });
    const keyControls = keyRow.createDiv({ cls: 'tlb-model-key-row' });
    this.keyInput = keyControls.createEl('input', { type: 'password', attr: { id: 'tlb-key', autocomplete: 'new-password', placeholder: '输入新密钥；留空则保留已保存密钥' } });
    this.keyInput.addEventListener('input', () => { this.typedKey = this.keyInput!.value; this.edited(); });
    const reveal = keyControls.createEl('button', { text: '显示', attr: { type: 'button', 'aria-label': '显示密钥' } });
    reveal.addEventListener('click', () => {
      this.revealKey = !this.revealKey;
      this.keyInput!.type = this.revealKey ? 'text' : 'password';
      reveal.textContent = this.revealKey ? '隐藏' : '显示';
      reveal.setAttribute('aria-label', this.revealKey ? '隐藏密钥' : '显示密钥');
    });
    const keyState = keyRow.createDiv({ cls: 'tlb-model-help' });
    keyState.dataset.keyState = 'true';
    this.renderKeyState();
    this.message = root.createDiv({ cls: 'tlb-model-message', attr: { role: 'status', 'aria-live': 'polite' } });
    const actions = root.createDiv({ cls: 'tlb-model-actions' });
    this.testButton = actions.createEl('button', { text: '测试连接', attr: { type: 'button' } });
    this.testButton.addEventListener('click', () => { void this.testConnection(); });
    const cancel = actions.createEl('button', { text: '取消', attr: { type: 'button' } });
    cancel.addEventListener('click', () => this.close());
    const saveButton = actions.createEl('button', { text: '保存并使用', cls: 'mod-cta', attr: { type: 'button' } });
    saveButton.addEventListener('click', () => { void this.saveDraft(); });
    this.updateKeyVisibility();
  }

  onClose() {
    this.closed = true;
    this.revision++;
    this.contentEl.empty();
  }

  private changeProvider(provider: Provider) {
    this.providerDrafts.set(this.provider, this.captureProviderDraft());
    this.provider = provider;
    const saved = this.providerDrafts.get(provider);
    if (saved) {
      this.draft.baseUrl = saved.baseUrl;
      this.draft.model = saved.model;
      this.draft.secretName = saved.secretName;
      this.secretIdentityUrl = saved.identityUrl;
      this.typedKey = saved.typedKey;
    } else {
      this.draft.baseUrl = providers[provider].url;
      this.draft.model = '';
      this.secretIdentityUrl = cleanUrl(this.draft.baseUrl);
      this.draft.secretName = this.secretIdentityUrl === cleanUrl(this.original.baseUrl)
        ? this.original.secretName
        : this.uniqueCustomSecretName();
      this.typedKey = '';
    }
    if (this.urlInput) this.urlInput.value = this.draft.baseUrl;
    if (this.modelInput) this.modelInput.value = this.draft.model;
    this.contentEl.querySelector('label[for="tlb-key"]')!.textContent = providers[provider].cloud ? '服务密钥' : '服务密钥（可选）';
    if (this.keyInput) this.keyInput.value = this.typedKey;
    this.revealKey = false;
    if (this.keyInput) this.keyInput.type = 'password';
    const reveal = this.contentEl.querySelector<HTMLButtonElement>('[aria-label="显示密钥"], [aria-label="隐藏密钥"]');
    if (reveal) { reveal.textContent = '显示'; reveal.setAttribute('aria-label', '显示密钥'); }
    this.updateKeyVisibility();
    this.providerDrafts.set(provider, this.captureProviderDraft());
    this.edited();
    this.renderKeyState();
  }

  private edited() {
    this.revision++;
    if (this.testButton) this.testButton.disabled = false;
    if (this.message) this.message.textContent = '';
  }

  private uniqueCustomSecretName() { return `the-last-brain-custom-${crypto.randomUUID()}`; }

  private captureProviderDraft(): ProviderDraft {
    return { baseUrl: this.draft.baseUrl, model: this.draft.model, secretName: this.draft.secretName, identityUrl: this.secretIdentityUrl, typedKey: this.typedKey };
  }

  private updateKeyVisibility() {
    if (this.keyRow) this.keyRow.style.display = this.provider === 'ollama' ? 'none' : '';
  }

  private syncSecretIdentity() {
    const url = cleanUrl(this.draft.baseUrl);
    if (url === this.secretIdentityUrl) return;
    this.draft.secretName = url === cleanUrl(this.original.baseUrl) ? this.original.secretName : this.uniqueCustomSecretName();
    this.secretIdentityUrl = url;
  }

  private currentStoredKey(): string {
    if (cleanUrl(this.draft.baseUrl) !== this.secretIdentityUrl) return '';
    try { return this.app.secretStorage.getSecret(this.draft.secretName) ?? ''; } catch { return ''; }
  }

  private renderKeyState() {
    const el = this.contentEl.querySelector<HTMLElement>('[data-key-state]');
    if (!el) return;
    const stored = !!this.currentStoredKey();
    el.textContent = stored ? '此服务地址已有密钥保存在 Obsidian 中；密钥内容不会显示。' : '密钥由 Obsidian SecretStorage 保存，不写入插件对话数据。';
  }

  private validate(apiKey: string) {
    if (/[\r\n]/.test(this.typedKey || apiKey)) throw new Error('密钥不能包含换行符，请检查输入。');
    if (providers[this.provider].cloud && !apiKey.trim()) throw new Error('云端服务需要密钥，请输入密钥或使用已保存的密钥。');
    try {
      buildRequest({ settings: this.draft, apiKey, messages: [], sources: [], memories: [], mode: 'chat' });
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error('服务配置无效，请检查模型名称和服务地址。');
    }
  }

  private async testConnection() {
    this.syncSecretIdentity();
    const version = this.revision;
    const apiKey = this.typedKey || this.currentStoredKey();
    try { this.validate(apiKey); }
    catch (error) { this.showMessage(error instanceof Error ? error.message : '请检查服务配置。', true); return; }
    this.testButton!.disabled = true;
    this.showMessage('正在测试连接…');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const request = buildRequest({
        settings: this.draft, apiKey, sources: [], memories: [], mode: 'chat',
        messages: [{ id: 'connection-test', role: 'user', content: 'Please reply with a brief greeting.', createdAt: Date.now(), sources: [] }],
      });
      const response = await Promise.race([
        requestUrl({ ...request, method: 'POST', throw: false }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error('timeout')); }, 15000); }),
      ]);
      if (this.closed || version !== this.revision) return;
      if (response.status < 200 || response.status >= 300) {
        this.showMessage(response.status === 401 || response.status === 403 ? '鉴权失败，请检查密钥和模型权限。' : response.status === 429 ? '请求限流或额度不足，请稍后重试。' : `服务返回错误（${response.status}），请检查服务地址和模型名称。`, true);
        return;
      }
      parseCompletion(response.json);
      this.showMessage('连接成功，模型已返回测试回答。');
    } catch (error) {
      if (!this.closed && version === this.revision) this.showMessage(timedOut ? '连接测试超时（15 秒）。' : '连接测试失败，请检查服务地址、密钥和网络。', true);
    } finally {
      clearTimeout(timer);
      if (!this.closed && version === this.revision) this.testButton!.disabled = false;
    }
  }

  private async saveDraft() {
    if (this.saving) return;
    this.syncSecretIdentity();
    if (this.plugin.busy) { this.showMessage('当前有请求正在运行，请稍后保存。', true); return; }
    const apiKey = this.typedKey || this.currentStoredKey();
    try { this.validate(apiKey); }
    catch (error) { this.showMessage(error instanceof Error ? error.message : '请检查服务配置。', true); return; }

    const previous = clone(this.plugin.data.settings);
    const previousSecret = this.currentStoredKey();
    this.draft.baseUrl = cleanUrl(this.draft.baseUrl);
    this.draft.model = this.draft.model.trim();
    this.plugin.data.settings = { ...this.plugin.data.settings, baseUrl: this.draft.baseUrl, model: this.draft.model, secretName: this.draft.secretName };
    this.saving = true;
    this.plugin.busy = true;
    this.revision++;
    this.setControlsDisabled(true);
    let secretChanged = false;
    try {
      if (this.typedKey) { this.app.secretStorage.setSecret(this.draft.secretName, this.typedKey.trim()); secretChanged = true; }
      await this.plugin.save();
      this.plugin.refresh();
      this.close();
    } catch {
      const current = this.plugin.data.settings;
      for (const key of ['baseUrl', 'model', 'secretName'] as const) {
        if (current[key] === this.draft[key]) current[key] = previous[key];
      }
      let keyRollbackFailed = false;
      if (secretChanged) {
        try { this.app.secretStorage.setSecret(this.draft.secretName, previousSecret); }
        catch { keyRollbackFailed = true; }
      }
      this.showMessage(keyRollbackFailed ? '设置已回滚，但密钥恢复失败。请检查 Obsidian 密钥存储。' : '保存失败，设置已回滚。请检查本地存储后重试。', true);
    } finally {
      this.saving = false;
      this.plugin.busy = false;
      this.plugin.refresh();
      if (!this.closed) this.setControlsDisabled(false);
    }
  }

  private setControlsDisabled(disabled: boolean) {
    this.controlsRoot?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button').forEach(el => { el.disabled = disabled; });
  }

  private showMessage(text: string, error = false) {
    if (!this.message) return;
    this.message.textContent = text;
    this.message.toggleClass('is-error', error);
    this.message.toggleClass('is-success', !error && !!text && text.startsWith('连接成功'));
  }
}
