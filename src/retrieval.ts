import type { Note, Retrieval, Settings, Source } from './types';
import { isExcluded } from './storage';

const tokens = (text: string): string[] => {
  const latin = text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  const cjk: string[] = [];
  for (const run of text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? []) {
    if (run.length === 1) cjk.push(run);
    else for (let i = 0; i < run.length - 1; i++) cjk.push(run.slice(i, i + 2));
  }
  const all = [...new Set([...latin, ...cjk])];
  // ponytail: cap lexical terms to keep long pasted questions responsive; semantic retrieval can replace this later.
  return all.length > 80 ? [...all.slice(0, 40), ...all.slice(-40)] : all;
};

function* chunks(text: string, size: number): Generator<string> {
  for (let start = 0; start < text.length; start += size - 160) {
    yield text.slice(start, start + size);
    if (start + size >= text.length) break;
  }
}

export function createRetriever(query: string, settings: Settings): { add(note: Note): void; finish(): Retrieval } {
  const budget = Number.isFinite(settings.contextChars) ? Math.max(0, Math.floor(settings.contextChars)) : 0;
  const maxSources = Number.isFinite(settings.maxSources) ? Math.max(0, Math.floor(settings.maxSources)) : 0;
  const queryTerms = tokens(query);
  const candidates: Array<{ source: Source; score: number }> = [];
  let scanned = 0;
  let skipped = 0;

  function add(note: Note): void {
    if (isExcluded(note.path, settings.excludedFolders)) { skipped++; return; }
    scanned++;
    if (!queryTerms.length || !maxSources) return;
    const lowerPath = note.path.toLocaleLowerCase();
    const titleHits = queryTerms.filter(term => lowerPath.includes(term)).length;
    let bestText = '';
    let bestScore = 0;
    for (const text of chunks(note.text, 1200)) {
      const lower = text.toLocaleLowerCase();
      const score = queryTerms.reduce((sum, term) => sum + Number(lower.includes(term)), 0);
      if (score > bestScore) { bestScore = score; bestText = text; }
    }

    if (!bestScore && (!titleHits || note.text.length === 0)) return;
    let chosen = bestText || note.text.slice(0, 1200);
    if (bestScore) {
      const matchAt = Math.min(...queryTerms.map(term => chosen.toLocaleLowerCase().indexOf(term)).filter(index => index >= 0));
      if (matchAt >= 0) chosen = chosen.slice(Math.max(0, matchAt - 80), Math.max(0, matchAt - 80) + 1200);
    }
    const candidate = { source: { path: note.path, text: chosen, mtime: note.mtime }, score: bestScore || titleHits };
    let index = candidates.findIndex(current => candidate.score > current.score ||
      candidate.score === current.score && candidate.source.path.localeCompare(current.source.path) < 0);
    if (index < 0) index = candidates.length;
    if (index < maxSources) candidates.splice(index, 0, candidate);
    if (candidates.length > maxSources) candidates.pop();
  }

  function finish(): Retrieval {
    const sources: Source[] = [];
    let used = 0;
    for (const { source } of candidates) {
      if (used >= budget) break;
      const remaining = budget - used;
      const matchAt = Math.min(...queryTerms.map(term => source.text.toLocaleLowerCase().indexOf(term)).filter(index => index >= 0));
      const start = Number.isFinite(matchAt) ? Math.max(0, matchAt - Math.min(80, Math.floor(remaining / 4))) : 0;
      const text = source.text.slice(start, start + remaining);
      if (!text) break;
      sources.push({ ...source, text });
      used += text.length;
    }
    return { sources, scanned, skipped };
  }
  return { add, finish };
}

export function retrieve(notes: Note[], query: string, settings: Settings): Retrieval {
  const retriever = createRetriever(query, settings);
  for (const note of notes) retriever.add(note);
  return retriever.finish();
}
