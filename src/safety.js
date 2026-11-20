// Text safety filters carried over from the first prototype.
// 1. No medicines: anything the ASHA is told must not name a medicine, dose or injection.
// 2. No diagnosis: AI text shown to the doctor may describe what was seen and heard, never name what it "is".
// Cited guideline text is official wording and is not filtered. Removed text is counted and logged, not shown.

const MEDICINE = /\b(tablet|tab\.|syrup|capsule|injection|inject|antibiotic|paracetamol|amoxicillin|ibuprofen|cotrimoxazole|gentamicin|dose|\d+\s?(mg|ml))\b|गोली|इंजेक्शन|एंटीबायोटिक|மாத்திரை|ஊசி|ஆன்டிபயாடிக்/i;

/** Keep only steps that name no medicine or dose. */
export function noMedicine(steps) {
  const kept = [];
  const removed = [];
  for (const s of steps || []) (MEDICINE.test(s) ? removed : kept).push(s);
  return { kept, removed };
}

const CONDITION = new RegExp(
  [
    'seps[ie]s', 'septic', 'pneumonia', 'meningitis', 'encephalitis', 'measles', 'chicken ?pox', 'varicella', 'dengue', 'malaria',
    'typhoid', 'cholera', 'tuberculosis', '\\bTB\\b', 'cellulitis', 'abscess', 'impetigo', 'scabies', 'eczema', 'dermatitis', 'psoriasis',
    'staphylococc', 'streptococc', 'scalded skin', 'stevens[- ]johnson', 'epidermal necrolysis', 'pemphig',
    'omphalitis', 'hyperbilirubin', 'kernicterus', 'eclampsia', 'anaemia', 'anemia', 'diabetes', 'hypertension', 'asthma',
    'bronchiolitis', 'bronchitis', 'gastroenteritis', 'dysentery', 'appendicitis', 'myocardial', 'heart attack', '\\bstroke\\b',
    'epilep', 'febrile seizure', 'rabies', 'tetanus', 'leprosy', 'herpes', 'shingles', 'ringworm', 'tinea', 'fungal infection',
    'bacterial infection', 'viral infection', 'syndrome', 'disease', 'disorder',
    // hedged diagnoses
    'diagnos', 'suggestive of', 'consistent with', 'indicative of', 'rule out', 'differential', 'suspect(ed)? ', 'likely (has|to be)', 'probable'
  ].join('|'),
  'i'
);

const sentences = (t) => String(t || '').split(/(?<=[.!?।])\s+/).filter(Boolean);

function noDiagnosisText(text) {
  const keep = [];
  const removed = [];
  for (const s of sentences(text)) (CONDITION.test(s) ? removed : keep).push(s);
  return { text: keep.join(' '), removed };
}

function noDiagnosisList(items, pick = (x) => x) {
  const kept = [];
  const removed = [];
  for (const item of items || []) (CONDITION.test(pick(item)) ? removed : kept).push(item);
  return { kept, removed: removed.map(pick) };
}

/**
 * Clean the AI output before it is stored and shown. Transcripts are kept verbatim: they are what the
 * worker said, not AI claims. Returns the cleaned output and the number of removed items.
 */
export function cleanAiOutput(output) {
  const summary = noDiagnosisText(output.summaryForDoctor);
  const observations = noDiagnosisList(output.photoObservations);
  const questions = noDiagnosisList(output.followUpQuestions, (q) => q.english);
  const uncertainty = noDiagnosisText(output.uncertaintyNotes);
  const removed = [...summary.removed, ...observations.removed, ...questions.removed, ...uncertainty.removed];
  return {
    output: {
      ...output,
      summaryForDoctor: summary.text || 'AI summary withheld by the no-diagnosis filter. Review the photo, voice note and transcript directly.',
      photoObservations: observations.kept,
      followUpQuestions: questions.kept,
      uncertaintyNotes: uncertainty.text,
      safetyRemoved: removed.length
    },
    removed: removed.length
  };
}
