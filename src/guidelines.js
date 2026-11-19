import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_CORPUS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'guidelines', 'young-infant.json');

// Small curated corpus with deterministic retrieval: matches on triggered danger signs first,
// then on keywords in the transcript/notes. Deterministic retrieval keeps citations auditable.
export function loadGuidelines(file = DEFAULT_CORPUS) {
  const corpus = JSON.parse(fs.readFileSync(file, 'utf8'));

  function retrieve({ signIds = [], text = '', level = 'ROUTINE', limit = 4 } = {}) {
    const lowered = String(text || '').toLowerCase();
    const wanted = new Set(signIds);
    const scored = corpus.entries.map((entry) => {
      const matchedSigns = entry.signs.filter((s) => wanted.has(s));
      const matchedKeywords = entry.keywords.filter((k) => lowered.includes(k.toLowerCase()));
      let score = matchedSigns.length * 10 + matchedKeywords.length;
      if (entry.boostForLevels?.includes(level)) score += 5;
      return { entry, score, matchedSigns };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ entry, matchedSigns }) => ({
        id: entry.id,
        title: entry.title,
        source: entry.source,
        summary: entry.summary,
        action: entry.action,
        matchedSigns
      }));
  }

  return { corpus: corpus.corpus, version: corpus.version, notice: corpus.notice, retrieve };
}
