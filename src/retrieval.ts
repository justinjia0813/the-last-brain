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

function chunks(text: string, size: number): string[] {
  const result: string[] = [];
  for (let start = 0; start < text.length; start += size - 160) {
    result.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
  }
  return result;
}

export function retrieve(notes: Note[], query: string, settings: Settings): Retrieval {
  const budget = Number.isFinite(settings.contextChars) ? Math.max(0, Math.floor(settings.contextChars)) : 0;
  const maxSources = Number.isFinite(settings.maxSources) ? Math.max(0, Math.floor(settings.maxSources)) : 0;
  const queryTerms = tokens(query);
  const excludedNotes = new Set(notes.filter(note => isExcluded(note.path, settings.excludedFolders)));
  const candidates: Array<{ source: Source; score: number }> = [];

  for (const note of notes) {
    if (excludedNotes.has(note) || queryTerms.length === 0) continue;
    const content = `${note.path}\n${note.text}`.toLocaleLowerCase();
    const hits = queryTerms.filter(term => content.includes(term)).length;
    if (!hits) continue;
    const noteChunks = chunks(note.text, 1200);
    const scored = noteChunks.map(text => {
      const lower = text.toLocaleLowerCase();
      return { text, score: queryTerms.reduce((sum, term) => sum + Number(lower.includes(term)), 0) };
    }).filter(chunk => chunk.score > 0).sort((a, b) => b.score - a.score);
    if (!scored.length && note.text.length === 0) continue;
    let chosen = scored[0]?.text ?? note.text.slice(0, 1200);
    if (scored.length) {
      const matchAt = Math.min(...queryTerms.map(term => chosen.toLocaleLowerCase().indexOf(term)).filter(index => index >= 0));
      if (matchAt >= 0) chosen = chosen.slice(Math.max(0, matchAt - 80), Math.max(0, matchAt - 80) + 1200);
    }
    candidates.push({ source: { path: note.path, text: chosen, mtime: note.mtime }, score: scored[0]?.score ?? hits });
  }

  candidates.sort((a, b) => b.score - a.score || a.source.path.localeCompare(b.source.path));
  const sources: Source[] = [];
  let used = 0;
  for (const { source } of candidates) {
    if (sources.length >= maxSources || used >= budget) break;
    const remaining = budget - used;
    const matchAt = Math.min(...queryTerms.map(term => source.text.toLocaleLowerCase().indexOf(term)).filter(index => index >= 0));
    const start = Number.isFinite(matchAt) ? Math.max(0, matchAt - Math.min(80, Math.floor(remaining / 4))) : 0;
    const text = source.text.slice(start, start + remaining);
    if (!text) break;
    sources.push({ ...source, text });
    used += text.length;
  }
  return { sources, scanned: notes.length, skipped: excludedNotes.size };
}
