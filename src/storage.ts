import { DEFAULT_SETTINGS, type PluginData } from './types';

export function isExcluded(path: string, folders: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  return folders.split(/[\n,;]/).map(p => p.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter(Boolean).some(p => normalized === p || normalized.startsWith(`${p}/`));
}

export function restoreData(raw: unknown): PluginData {
  if (raw == null) return { version: 1, settings: { ...DEFAULT_SETTINGS }, conversations: [], memories: [], activeConversationId: null };
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const sources = (v: unknown) => Array.isArray(v) && v.every(s => object(s) && typeof s.path === 'string' && typeof s.text === 'string' && number(s.mtime));
  if (!object(raw) || raw.version !== 1 || !object(raw.settings) || !Array.isArray(raw.conversations) || !Array.isArray(raw.memories)) throw new Error('Invalid plugin data');
  for (const c of raw.conversations) {
    if (!object(c) || typeof c.id !== 'string' || typeof c.title !== 'string' || !number(c.createdAt) || !number(c.updatedAt) || !Array.isArray(c.messages)) throw new Error('Invalid conversation');
    for (const m of c.messages) if (!object(m) || typeof m.id !== 'string' || !['user', 'assistant'].includes(String(m.role)) || typeof m.content !== 'string' || !number(m.createdAt) || !sources(m.sources)) throw new Error('Invalid message');
  }
  for (const m of raw.memories) if (!object(m) || typeof m.id !== 'string' || typeof m.conversationId !== 'string' || typeof m.content !== 'string' || !['draft', 'confirmed'].includes(String(m.status)) || !number(m.createdAt) || !sources(m.sources)) throw new Error('Invalid memory');
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of ['baseUrl', 'model', 'secretName', 'excludedFolders'] as const) if (typeof raw.settings[key] === 'string') settings[key] = raw.settings[key];
  settings.networkConsent = raw.settings.networkConsent === true;
  for (const key of ['maxSources', 'contextChars'] as const) if (typeof raw.settings[key] === 'number' && Number.isFinite(raw.settings[key])) settings[key] = key === 'maxSources' ? Math.max(1, Math.min(10, Math.floor(raw.settings[key]))) : Math.max(1000, Math.min(32000, Math.floor(raw.settings[key])));
  return { version: 1, settings, conversations: raw.conversations as PluginData['conversations'], memories: raw.memories as PluginData['memories'], activeConversationId: typeof raw.activeConversationId === 'string' && raw.conversations.some(c => c.id === raw.activeConversationId) ? raw.activeConversationId : raw.conversations[0]?.id ?? null };
}
