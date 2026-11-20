// Rash photo check: what a skin photo LOOKS like, never what disease it is. Used by the ASHA phone (labels)
// and the server (Gemini output validation). The result is a hint for the worker only: it is not saved
// with the case, never changes the urgency level, and the doctor names any disease.
// DRAFT clinical wording: needs clinician sign-off. Hindi and Tamil need native-speaker review.

export const SKIN_PATTERN_VERSION = 'skin-pattern-2026.11-draft';

// `checks`: danger-sign ids (public/shared/dangerSigns.js) the worker should look for with this pattern.
export const SKIN_PATTERNS = [
  {
    id: 'ring_patches',
    label: { en: 'Round or ring-shaped patches', hi: 'गोल या छल्ले जैसे धब्बे', ta: 'வட்ட அல்லது வளைய வடிவத் திட்டுகள்' },
    checks: ['fever']
  },
  {
    id: 'small_bumps',
    label: { en: 'Many small bumps or short lines', hi: 'कई छोटे दाने या छोटी लकीरें', ta: 'பல சிறிய கொப்புளங்கள் அல்லது சிறு கோடுகள்' },
    checks: ['many_skin_pustules', 'fever']
  },
  {
    id: 'blisters_pustules',
    label: { en: 'Blisters, pus spots or crusts', hi: 'छाले, मवाद वाले दाने या पपड़ी', ta: 'நீர்க்கொப்புளங்கள், சீழ்ப் புள்ளிகள் அல்லது பொருக்கு' },
    checks: ['many_skin_pustules', 'skin_blisters', 'umbilicus_red_or_pus', 'fever']
  },
  {
    id: 'spreading_redness',
    label: { en: 'Red, swollen area', hi: 'लाल, सूजा हुआ हिस्सा', ta: 'சிவந்து வீங்கிய பகுதி' },
    checks: ['umbilical_redness_spreading', 'wound_infected', 'fever']
  },
  {
    id: 'dry_scaly',
    label: { en: 'Dry, scaly or thick patches', hi: 'सूखे, पपड़ीदार या मोटे धब्बे', ta: 'உலர்ந்த, செதில் அல்லது தடித்த திட்டுகள்' },
    checks: ['fever']
  },
  {
    id: 'many_red_spots',
    label: { en: 'Many small red spots over a large area', hi: 'बड़े हिस्से पर कई छोटे लाल दाने', ta: 'பெரிய பகுதியில் பல சிறிய சிவப்புப் புள்ளிகள்' },
    checks: ['fever', 'lethargic', 'unable_to_drink']
  },
  {
    id: 'yellow_skin',
    label: { en: 'Yellow skin or eyes', hi: 'त्वचा या आँखें पीली', ta: 'தோல் அல்லது கண்கள் மஞ்சள்' },
    checks: ['severe_jaundice', 'jaundice']
  },
  {
    id: 'wound_or_burn',
    label: { en: 'Wound or burn', hi: 'घाव या जलना', ta: 'காயம் அல்லது தீக்காயம்' },
    checks: ['wound_infected', 'burn', 'fever']
  },
  {
    id: 'other',
    label: { en: 'Other skin change', hi: 'त्वचा में कोई और बदलाव', ta: 'தோலில் வேறு மாற்றம்' },
    checks: ['fever']
  },
  {
    id: 'unclear',
    label: { en: 'Photo not clear enough', hi: 'फ़ोटो साफ़ नहीं है', ta: 'புகைப்படம் தெளிவாக இல்லை' },
    checks: [],
    retake: true
  },
  {
    id: 'not_skin',
    label: { en: 'Not a photo of skin', hi: 'यह त्वचा की फ़ोटो नहीं है', ta: 'இது தோலின் புகைப்படம் இல்லை' },
    checks: [],
    retake: true
  }
];

export const SKIN_PATTERN_IDS = SKIN_PATTERNS.map((p) => p.id);

export function getSkinPattern(id) {
  return SKIN_PATTERNS.find((p) => p.id === id) || SKIN_PATTERNS.find((p) => p.id === 'unclear');
}

export function skinPatternLabel(id, lang = 'en') {
  const p = getSkinPattern(id);
  return p.label[lang] || p.label.en;
}
