import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { noMedicine } from './safety.js';

const DEFAULT_CORPUS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'guidelines', 'all-ages.json');

// Who each entry is written for. ctx comes from patientContext() / triage.context.
function populationMatches(population, ctx = {}) {
  const youngInfant = ctx.youngInfant ?? true;
  const under5 = ctx.under5 ?? false;
  switch (population) {
    case 'young_infant':
      return youngInfant;
    case 'child':
      return !youngInfant && under5;
    case 'under5':
      return youngInfant || under5;
    case 'over5':
      return !youngInfant && !under5;
    case 'pregnancy':
      return Boolean(ctx.pregnant);
    default:
      return true;
  }
}

// Small curated corpus with deterministic retrieval: matches on triggered danger signs first,
// then on keywords in the transcript/notes, limited to entries written for this patient's age group
// or pregnancy. Deterministic retrieval keeps citations auditable.
export function loadGuidelines(file = DEFAULT_CORPUS) {
  const corpus = JSON.parse(fs.readFileSync(file, 'utf8'));

  // topSignIds: signs that set the final level; entries covering them rank first (their steps reach the ASHA).
  function retrieve({ signIds = [], topSignIds = [], text = '', level = 'ROUTINE', context, limit = 4 } = {}) {
    const lowered = String(text || '').toLowerCase();
    const wanted = new Set(signIds);
    const top = new Set(topSignIds);
    const scored = corpus.entries
      .filter((entry) => !entry.fallback && populationMatches(entry.population, context))
      .map((entry) => {
        const matchedSigns = entry.signs.filter((s) => wanted.has(s));
        const matchedKeywords = entry.keywords.filter((k) => lowered.includes(k.toLowerCase()));
        let score = matchedSigns.length * 10 + matchedKeywords.length + entry.signs.filter((s) => top.has(s)).length * 20;
        if (entry.boostForLevels?.includes(level)) score += 5;
        return { entry, score, matchedSigns };
      });
    let hits = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    // Nothing recognised: cite the "doctor reviews every unrecognised case" policy.
    if (hits.length === 0) {
      const fallback = corpus.entries.find((e) => e.fallback);
      if (fallback) hits = [{ entry: fallback, matchedSigns: [] }];
    }
    return hits.map(({ entry, matchedSigns }) => ({
      id: entry.id,
      title: entry.title,
      source: entry.source,
      summary: entry.summary,
      action: entry.action,
      population: entry.population,
      steps: entry.steps || null,
      matchedSigns
    }));
  }

  return { corpus: corpus.corpus, version: corpus.version, notice: corpus.notice, retrieve };
}

/**
 * "What to do now" steps for the ASHA, in every supported language: from the best-matching cited
 * guideline that has steps. Curated text, filtered again so no medicine or dose ever reaches the phone.
 */
export function workerSteps(refs) {
  const withSteps = (refs || []).find((g) => g.steps);
  if (!withSteps) return null;
  const out = { guidelineId: withSteps.id, title: withSteps.title };
  for (const [lang, steps] of Object.entries(withSteps.steps)) out[lang] = noMedicine(steps).kept;
  return out;
}
