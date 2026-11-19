// Writes the exact Gemini system instruction, response schema and a sample prompt to docs/ai-studio/
// so they can be pasted into Google AI Studio to compare models and lock the output format.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIGN_IDS } from '../public/shared/dangerSigns.js';
import { SYSTEM_INSTRUCTION, buildUserPrompt } from '../src/ai/prompt.js';
import { AI_OUTPUT_JSON_SCHEMA, PROMPT_VERSION } from '../src/ai/schema.js';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'ai-studio');
await fs.mkdir(out, { recursive: true });

const sample = {
  language: 'ta',
  patient: { ageDays: 8, sex: 'female' },
  assessment: {
    signs: Object.fromEntries(SIGN_IDS.map((id) => [id, id === 'not_feeding_well' ? 'yes' : 'unknown'])),
    temperatureC: null,
    breathsPerMin: null,
    notes: 'Red skin around the navel. Mother says the baby is not feeding and feels hot.'
  }
};

await fs.writeFile(path.join(out, 'system-instruction.txt'), `${SYSTEM_INSTRUCTION}\n`);
await fs.writeFile(path.join(out, 'response-schema.json'), `${JSON.stringify(AI_OUTPUT_JSON_SCHEMA, null, 2)}\n`);
await fs.writeFile(path.join(out, 'sample-user-prompt.txt'), `${buildUserPrompt(sample, { hasPhoto: true, hasAudio: true })}\n`);
console.log(`Exported prompt ${PROMPT_VERSION} to docs/ai-studio/`);
