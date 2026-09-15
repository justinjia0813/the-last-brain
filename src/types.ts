export interface Settings {
  baseUrl: string;
  model: string;
  secretName: string;
  excludedFolders: string;
  maxSources: number;
  contextChars: number;
  networkConsent: boolean;
}
export const DEFAULT_SETTINGS: Settings = {
  baseUrl: 'https://api.openai.com/v1', model: '', secretName: 'the-last-brain',
  excludedFolders: '', maxSources: 6, contextChars: 16000, networkConsent: false,
};
export interface Source { path: string; text: string; mtime: number; }
export interface Message { id: string; role: 'user' | 'assistant'; content: string; createdAt: number; sources: Source[]; }
export interface Conversation { id: string; title: string; createdAt: number; updatedAt: number; messages: Message[]; }
export interface Memory { id: string; conversationId: string; content: string; sources: Source[]; createdAt: number; status: 'draft' | 'confirmed'; }
export interface PluginData { version: 1; settings: Settings; conversations: Conversation[]; memories: Memory[]; activeConversationId: string | null; }
export interface Note { path: string; text: string; mtime: number; }
export interface Retrieval { sources: Source[]; scanned: number; skipped: number; }
export interface CompletionInput { settings: Settings; apiKey: string; messages: Message[]; sources: Source[]; memories: Memory[]; mode: 'chat' | 'memory'; }
export interface ChatHost {
  data: PluginData;
  busy: boolean;
  status: string;
  error: string;
  save(): Promise<void>;
  newConversation(): Promise<void>;
  selectConversation(id: string): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  send(text: string): Promise<void>;
  distill(): Promise<void>;
  confirmMemory(id: string): Promise<void>;
  deleteMemory(id: string): Promise<void>;
  openSource(path: string): Promise<void>;
  openSettings(): void;
}
