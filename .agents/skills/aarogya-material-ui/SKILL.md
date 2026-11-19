---
name: aarogya-material-ui
description: Use when building or changing any screen, component, color, icon or layout in the Aarogya-Vision worker app (public/index.html) or doctor console (public/doctor.html). Keeps the UI on official Google Material 3 (Material Web) components and tokens.
---

# Material 3 UI conventions

## Goal
A consistent Google Material 3 look, accessible in light and dark mode, that works offline on low-end Android phones.

## Instructions
1. Use official `@material/web` components only. Add new imports to `ui/material.js`, then run `npm run build`.
2. Colors come only from `--md-sys-color-*` tokens and the harmonised `--app-color-warning*` / `--app-color-success*` custom colors generated in `public/vendor/theme.css` by `scripts/theme-tokens.mjs` (Material Color Utilities, seed #0B57D0). Never hard-code hex values in `public/css/app.css`.
3. Icons: Material Symbols (rounded) via `icon(name)` from `public/js/icons.js`. Add new names to the `ICONS` list in `scripts/build-ui.mjs`. Do not hand-draw SVGs.
4. Shape follows the M3 scale: buttons and chips full (component default), text fields extra-small, cards 12px, panes 16px.
5. Urgency colors: URGENT uses error / error-container, PRIORITY warning-container, ROUTINE success-container.
6. Typography: `md-typescale-*` classes. Fonts are self-hosted Roboto and Noto Sans Tamil/Devanagari.
7. Inside `<form>`, give every Material button that is not a submit button `type="button"`. Material buttons default to submit.
8. Keep the worker flow to two capture actions (Take photo, Speak), one consent switch, one optional danger switch and one Send button. Gemini fills the fields; do not add form fields to the worker app.
9. `md-switch` cannot be reset by setting `selected = false` after a user has toggled it. Replace the element (see `resetSwitch` in `public/js/worker-app.js`).
10. Build DOM with `el()` from `public/js/dom.js`. It never parses strings as HTML. Use `setChildren` / `appendChildren` when children can be null.
11. Add any new worker-app file to the `SHELL` list in `public/sw.js` so it works offline.

## Constraints
- No third-party CDNs, fonts or icon sets at runtime.
- No inline `<script>` or `<style>`. The CSP allows only style attributes, which Material Web needs.
- No em dashes in UI text. Test both color schemes (`emulateMedia({ colorScheme: 'dark' })` in Playwright).
