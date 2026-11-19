// Safety evaluation over synthetic young-infant cases.
//   npm run eval            rules only (offline, deterministic)
//   npm run eval -- --ai    also runs the configured Gemini provider on each case's text and checks that
//                           AI findings never lower urgency (needs GEMINI_API_KEY or Vertex AI config)
// Exit code 1 on any under-triage: a case scored lower than its expected level.
import fs from 'node:fs';
import { SIGN_IDS } from '../public/shared/dangerSigns.js';
import { levelRank, mergeAiFindings, triageAssessment } from '../public/shared/triage.js';
import { loadConfig } from '../src/config.js';
import { createProvider } from '../src/bootstrap.js';

const useAi = process.argv.includes('--ai');
const { cases } = JSON.parse(fs.readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));

function toRecord(c) {
  const signs = Object.fromEntries(SIGN_IDS.map((id) => [id, c.signs[id] ?? 'no']));
  return {
    id: c.id,
    language: 'en',
    patient: { ageDays: c.ageDays, sex: 'unknown' },
    assessment: { signs, temperatureC: c.temperatureC ?? null, breathsPerMin: c.breathsPerMin ?? null, notes: c.notes }
  };
}

let provider = null;
if (useAi) {
  const config = loadConfig({ ...process.env, NODE_ENV: 'development' });
  if (config.ai.provider !== 'gemini') {
    console.error('--ai needs GEMINI_API_KEY (or GOOGLE_GENAI_USE_ENTERPRISE=true with GOOGLE_CLOUD_PROJECT).');
    process.exit(2);
  }
  provider = createProvider(config.ai);
  console.log(`AI provider: Gemini ${config.ai.model} (text only: the worker notes stand in for the voice note)\n`);
}

const rows = [];
let underTriage = 0;
let aiLowered = 0;
for (const c of cases) {
  const record = toRecord(c);
  const rules = triageAssessment(record);
  const row = { id: c.id, expected: c.expected, rules: rules.level, ai: '', result: 'ok' };

  if (levelRank(rules.level) < levelRank(c.expected)) {
    row.result = 'UNDER-TRIAGE';
    underTriage += 1;
  } else if (levelRank(rules.level) > levelRank(c.expected)) {
    row.result = 'over-triage';
  }

  if (provider) {
    try {
      // Treat the notes as what the worker said, so the model can surface voice-reported signs.
      const { output } = await provider.analyze({ caseRecord: record, photo: null, audio: null });
      const findings = output.findings.map((f) => ({ ...f, source: 'voice' }));
      const merged = mergeAiFindings(rules, { status: 'done', findings }, { hasMedia: false });
      row.ai = merged.level;
      if (levelRank(merged.level) < levelRank(rules.level)) {
        aiLowered += 1;
        row.result = 'AI-LOWERED';
      }
      const target = c.expectedWithAi || c.expected;
      if (levelRank(merged.level) < levelRank(target)) {
        underTriage += 1;
        row.result = 'UNDER-TRIAGE (with AI)';
      }
    } catch (err) {
      row.ai = `error: ${err.message.slice(0, 60)}`;
    }
  }
  rows.push(row);
}

console.table(rows);
const summary = { cases: rows.length, underTriage, overTriage: rows.filter((r) => r.result === 'over-triage').length, aiLowered };
console.log(summary);
if (underTriage > 0 || aiLowered > 0) {
  console.error('SAFETY CHECK FAILED');
  process.exit(1);
}
console.log('Safety check passed: no case was scored below its expected level.');
