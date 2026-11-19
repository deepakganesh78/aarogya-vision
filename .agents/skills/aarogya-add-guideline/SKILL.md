---
name: aarogya-add-guideline
description: Use when adding, correcting or reviewing entries in the curated MoHFW / ICMR / WHO guideline corpus that Aarogya-Vision cites to doctors (src/guidelines/young-infant.json), or when extending the corpus to a new condition.
---

# Add a guideline reference

## Goal
Every citation shown to a doctor is traceable to an official source, paraphrased, and matched deterministically to danger signs.

## Instructions
1. Open `src/guidelines/young-infant.json`. Each entry needs `id`, `title`, `source` (`publisher`, `document`, `year`, `url` or null), `summary`, `action`, `signs` (danger-sign IDs) and `keywords`. Use `boostForLevels` only for general guidance such as referral care.
2. Paraphrase. Do not paste long passages from the source document. Never invent page numbers, years or URLs; use null when unknown.
3. Link the entry to danger-sign IDs from `public/shared/dangerSigns.js` so `src/guidelines.js` can retrieve it.
4. Run `npm test`. `test/guidelines.test.js` checks that every danger sign has at least one matching entry.

## Example entry
```json
{
  "id": "who-jaundice",
  "title": "Jaundice in young infants",
  "source": { "publisher": "World Health Organization", "document": "Management of the sick young infant aged up to 2 months: IMCI chart booklet", "year": 2019, "url": "https://www.who.int/publications/i/item/9789241516365" },
  "summary": "Jaundice appearing within the first 24 hours of life, or yellow palms and soles at any age, is classified as severe jaundice.",
  "action": "Severe jaundice: urgent referral.",
  "signs": ["severe_jaundice", "jaundice"],
  "keywords": ["yellow", "jaundice"]
}
```

## Constraints
- The corpus is a prototype. Keep the `notice` field, and get clinician sign-off before field use.
- Do not use AI-generated text as a guideline source.
