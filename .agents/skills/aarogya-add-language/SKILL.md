---
name: aarogya-add-language
description: Use when asked to add or improve a language for the ASHA worker app (for example Telugu, Kannada, Marathi or Bengali), including UI strings, danger-sign labels, triage reasons, Gemini translation and fonts.
---

# Add a worker language

## Goal
Add a new ASHA-facing language without rewriting any app logic.

## Instructions
1. Pick the ISO 639-1 code (for example `te` for Telugu).
2. `public/js/i18n.js`: copy the `en` block to a new key, translate every string, and add `{ code, name }` to `LANGUAGES` using the language's own script for `name`.
3. `public/shared/dangerSigns.js`: add a `label.<code>` for every sign.
4. `public/shared/triage.js`: add a `TEXT.<code>` block for reason descriptions.
5. `src/validation.js`: add the code to the `language` enum. `src/ai/prompt.js`: add it to `LANGUAGE_NAMES` so Gemini writes follow-up questions and translations in that language.
6. Fonts: add the matching `@fontsource/noto-sans-<script>` package, import it in `ui/fonts.css`, add the family to `--md-ref-typeface-*` in `scripts/theme-tokens.mjs`, then run `npm run build`.
7. Add a `describeReason` assertion for the new language in `test/triage.test.js` and run `npm test` and `npm run test:e2e`.

## Constraints
- Mark new translations as drafts for native-speaker and clinical review.
- Keep wording simple, everyday and action-first, as for the existing Hindi and Tamil text.
- Use plain hyphens, not em or en dashes, in UI text.
