// Danger signs for every age group an ASHA sees on a home visit.
// - Young infant (0-59 days): adapted from WHO "Management of the sick young infant aged up to 2 months"
//   (IMCI chart booklet, 2019) and India's IMNCI chart booklet. These are "required": each must be answered.
// - Child (2 months-5 years), older children and adults, and pregnancy: paraphrased from IMNCI general danger
//   signs, MoHFW ANC danger signs and MoHFW standard treatment guidelines.
// PROTOTYPE CONTENT: wording and thresholds must be signed off by a clinician before field use.
// Hindi/Tamil labels and keywords are drafts that need native-speaker review.

export const RULES_VERSION = 'all-ages-2026.11-draft';

export const LEVELS = ['ROUTINE', 'PRIORITY', 'URGENT'];

/** Young infant upper limit (days). Older patients use the all-ages signs. */
export const MAX_AGE_DAYS = 59;
const UNDER_FIVE_DAYS = 5 * 365;

/**
 * Who a sign applies to:
 *   young_infant  0-59 days (also used when age is unknown, the safest default)
 *   older         everyone over 59 days
 *   child         2 months to 5 years
 *   pregnancy     pregnant women
 *   any           everyone
 * `level` is the usual level; `levelFor(ctx, isYes)` adjusts it for the patient and other signs.
 * `kw` are words in the worker's typed note (any language) that mark the sign present.
 */
export const DANGER_SIGNS = [
  // ---- Young infant (0-59 days) ---------------------------------------------------------------
  {
    id: 'not_feeding_well',
    group: 'young_infant',
    level: 'URGENT',
    required: true,
    label: {
      en: 'Not able to feed, or stopped feeding well (not sucking)',
      hi: 'दूध नहीं पी पा रहा, या ठीक से दूध पीना बंद कर दिया (चूस नहीं रहा)',
      ta: 'பால் குடிக்க முடியவில்லை, அல்லது சரியாகப் பால் குடிப்பதை நிறுத்திவிட்டது (உறிஞ்சவில்லை)'
    },
    kw: ['not feeding', 'not sucking', 'stopped feeding', 'not breastfeeding', 'refuses feed', 'not taking milk', 'not taking the breast', 'unable to feed', 'दूध नहीं', 'पी नहीं', 'பால் குடிக்க', 'குடிக்கவில்லை', 'பால் குடிக்கல']
  },
  {
    id: 'convulsions',
    group: 'any',
    level: 'URGENT',
    required: true,
    label: { en: 'Convulsions (fits)', hi: 'दौरे / झटके आना', ta: 'வலிப்பு' },
    kw: ['convulsion', 'having fits', 'had fits', 'seizure', 'jerking', 'दौरा', 'दौरे', 'झटके', 'வலிப்பு']
  },
  {
    id: 'fast_breathing',
    group: 'young_infant',
    level: 'URGENT',
    required: true,
    label: {
      en: 'Fast breathing (60 or more breaths in one minute)',
      hi: 'तेज़ साँस (एक मिनट में 60 या अधिक)',
      ta: 'வேகமான மூச்சு (ஒரு நிமிடத்தில் 60 அல்லது அதற்கு மேல்)'
    },
    kw: ['fast breathing', 'breathing fast', 'breathing very fast', 'तेज़ साँस', 'तेज सांस', 'வேகமா மூச்சு', 'வேகமான மூச்சு']
  },
  {
    id: 'severe_chest_indrawing',
    group: 'young_infant',
    level: 'URGENT',
    required: true,
    label: {
      en: 'Severe chest indrawing',
      hi: 'साँस लेते समय छाती का ज़्यादा अंदर धँसना',
      ta: 'மூச்சுவிடும்போது மார்பு கடுமையாக உள்ளிழுத்தல்'
    },
    kw: ['chest indrawing', 'chest pulling in', 'grunting', 'छाती धँस', 'மார்பு உள்ளிழு']
  },
  {
    id: 'fever',
    group: 'any',
    level: 'URGENT',
    // Fever is a very-severe-disease sign in a young infant; in older patients it means "see a doctor today".
    levelFor: (ctx) => (ctx.youngInfant ? 'URGENT' : 'PRIORITY'),
    required: true,
    label: {
      en: 'Fever: 37.5 °C or above, or feels hot',
      hi: 'बुखार: 37.5 °C या अधिक, या छूने पर गरम',
      ta: 'காய்ச்சல்: 37.5 °C அல்லது அதற்கு மேல், அல்லது தொட்டால் சூடாக உள்ளது'
    },
    kw: ['fever', 'feels hot', 'hot body', 'very hot', 'bukhar', 'बुखार', 'गरम', 'காய்ச்சல்', 'சூடா', 'சூடாக']
  },
  {
    id: 'low_temperature',
    group: 'young_infant',
    level: 'URGENT',
    required: true,
    label: {
      en: 'Low body temperature: below 35.5 °C, or feels cold',
      hi: 'शरीर का कम तापमान: 35.5 °C से कम, या छूने पर ठंडा',
      ta: 'குறைந்த உடல் வெப்பநிலை: 35.5 °C க்குக் கீழ், அல்லது தொட்டால் குளிர்ச்சியாக உள்ளது'
    },
    kw: ['feels cold', 'cold to touch', 'body cold', 'very cold', 'ठंडा', 'குளிர்ச்சியா', 'உடல் குளிர']
  },
  {
    id: 'low_movement',
    group: 'young_infant',
    level: 'URGENT',
    required: true,
    label: {
      en: 'Moves only when stimulated, or does not move at all',
      hi: 'केवल छूने/हिलाने पर ही हिलता है, या बिल्कुल नहीं हिलता',
      ta: 'தூண்டினால் மட்டுமே அசைகிறது, அல்லது அசையவே இல்லை'
    },
    kw: ['not moving', 'very sleepy', 'floppy', 'limp', 'hard to wake', 'lethargic', 'सुस्त', 'हिल नहीं', 'அசையவில்லை', 'சோர்வா']
  },
  {
    id: 'umbilical_redness_spreading',
    group: 'young_infant',
    level: 'URGENT',
    required: true,
    label: {
      en: 'Redness around the navel spreading to the skin',
      hi: 'नाभि के आसपास लाली जो त्वचा पर फैल रही है',
      ta: 'தொப்புளைச் சுற்றி உள்ள சிவப்பு தோலுக்குப் பரவுகிறது'
    },
    kw: ['redness spreading from the navel', 'navel redness spreading', 'red spreading around the navel']
  },
  {
    id: 'umbilicus_red_or_pus',
    group: 'young_infant',
    level: 'PRIORITY',
    required: false,
    label: {
      en: 'Navel red or draining pus (redness not spreading)',
      hi: 'नाभि लाल है या उसमें से मवाद निकल रहा है (लाली फैल नहीं रही)',
      ta: 'தொப்புள் சிவந்துள்ளது அல்லது சீழ் வடிகிறது (சிவப்பு பரவவில்லை)'
    },
    kw: ['navel', 'umbilic', 'belly button', 'cord is red', 'नाभि', 'தொப்புள்']
  },
  {
    id: 'many_skin_pustules',
    group: 'young_infant',
    level: 'URGENT',
    required: true,
    label: {
      en: '10 or more skin pustules, or a big boil',
      hi: 'त्वचा पर 10 या अधिक फुंसियाँ, या एक बड़ा फोड़ा',
      ta: 'தோலில் 10 அல்லது அதற்கு மேற்பட்ட சீழ்க் கொப்புளங்கள், அல்லது ஒரு பெரிய கட்டி'
    },
    kw: ['many pustules', 'big boil', 'बड़ा फोड़ा', 'பெரிய கட்டி']
  },
  {
    id: 'few_skin_pustules',
    group: 'young_infant',
    level: 'PRIORITY',
    required: false,
    label: {
      en: 'A few skin pustules (fewer than 10)',
      hi: 'त्वचा पर कुछ फुंसियाँ (10 से कम)',
      ta: 'தோலில் சில சீழ்க் கொப்புளங்கள் (10 க்குக் குறைவு)'
    },
    kw: ['pustule', 'फुंसी', 'சீழ்க் கொப்புள']
  },
  {
    id: 'severe_jaundice',
    group: 'young_infant',
    level: 'URGENT',
    required: true,
    label: {
      en: 'Yellow palms and soles, or yellow skin in the first 24 hours of life',
      hi: 'हथेलियाँ और तलवे पीले, या जन्म के पहले 24 घंटों में त्वचा पीली',
      ta: 'உள்ளங்கைகளும் உள்ளங்கால்களும் மஞ்சளாக உள்ளன, அல்லது பிறந்த முதல் 24 மணி நேரத்தில் தோல் மஞ்சளாக உள்ளது'
    },
    kw: ['yellow palms', 'yellow soles', 'पीली हथेली', 'உள்ளங்கை மஞ்சள்']
  },
  {
    id: 'jaundice',
    group: 'young_infant',
    level: 'PRIORITY',
    required: false,
    label: {
      en: 'Yellow eyes or skin (palms and soles not yellow)',
      hi: 'आँखें या त्वचा पीली (हथेलियाँ और तलवे पीले नहीं)',
      ta: 'கண்கள் அல்லது தோல் மஞ்சளாக உள்ளது (உள்ளங்கை, உள்ளங்கால் மஞ்சள் இல்லை)'
    },
    kw: ['jaundice', 'yellow skin', 'yellow eyes', 'पीलिया', 'மஞ்சள் காமாலை', 'மஞ்சள்']
  },

  // ---- Older children and adults (over 59 days) -----------------------------------------------
  {
    id: 'lethargic',
    group: 'older',
    level: 'URGENT',
    label: {
      en: 'Very sleepy, unconscious or hard to wake',
      hi: 'बहुत सुस्त, बेहोश या जगाना मुश्किल',
      ta: 'மிகவும் சோர்வு, மயக்கம் அல்லது எழுப்புவது கடினம்'
    },
    kw: ['lethargic', 'unconscious', 'very sleepy', 'not waking', 'hard to wake', 'limp', 'बेहोश', 'सुस्त', 'மயக்க', 'சோர்வா']
  },
  {
    id: 'difficult_breathing',
    group: 'older',
    level: 'URGENT',
    label: {
      en: 'Fast or difficult breathing, or chest indrawing',
      hi: 'तेज़ या मुश्किल से साँस, या छाती का अंदर धँसना',
      ta: 'வேகமான அல்லது சிரமமான மூச்சு, அல்லது மார்பு உள்ளிழுத்தல்'
    },
    kw: ['fast breathing', 'difficulty breathing', 'difficult breathing', 'breathless', 'chest indrawing', 'grunting', 'cannot breathe', 'सांस', 'साँस', 'மூச்சு']
  },
  {
    id: 'unable_to_drink',
    group: 'child',
    level: 'URGENT',
    label: {
      en: 'Child not able to drink or breastfeed',
      hi: 'बच्चा पी नहीं पा रहा या स्तनपान नहीं कर पा रहा',
      ta: 'குழந்தை குடிக்கவோ தாய்ப்பால் குடிக்கவோ முடியவில்லை'
    },
    kw: ['not drinking', 'unable to drink', 'not feeding', 'not breastfeeding', 'not taking the breast', 'दूध नहीं', 'पी नहीं', 'குடிக்கவில்லை', 'பால் குடிக்கல']
  },
  {
    id: 'vomits_everything',
    group: 'older',
    level: 'URGENT',
    label: { en: 'Vomits everything', hi: 'सब कुछ उल्टी कर देता है', ta: 'எல்லாவற்றையும் வாந்தி எடுக்கிறது' },
    kw: ['vomits everything', 'vomiting everything', 'cannot keep anything down', 'सब उल्टी', 'எல்லாம் வாந்தி']
  },
  {
    id: 'chest_pain',
    group: 'older',
    level: 'URGENT',
    label: { en: 'Chest pain', hi: 'सीने में दर्द', ta: 'நெஞ்சு வலி' },
    kw: ['chest pain', 'pain in the chest', 'सीने में दर्द', 'நெஞ்சு வலி']
  },

  // ---- Pregnancy --------------------------------------------------------------------------------
  {
    id: 'preg_bleeding',
    group: 'pregnancy',
    level: 'URGENT',
    label: { en: 'Bleeding in pregnancy', hi: 'गर्भावस्था में खून आना', ta: 'கர்ப்ப காலத்தில் இரத்தப்போக்கு' },
    kw: ['bleeding', 'blood', 'खून', 'रक्तस्राव', 'ரத்தப்போக்கு', 'இரத்தப்போக்கு', 'இரத்தம்']
  },
  {
    id: 'preg_headache_vision',
    group: 'pregnancy',
    level: 'URGENT',
    label: {
      en: 'Severe headache or blurred vision in pregnancy',
      hi: 'गर्भावस्था में तेज़ सिरदर्द या धुंधला दिखना',
      ta: 'கர்ப்ப காலத்தில் கடும் தலைவலி அல்லது மங்கலான பார்வை'
    },
    kw: ['headache', 'blurred vision', 'blurry', 'सिरदर्द', 'धुंधला', 'தலைவலி', 'மங்கலா']
  },
  {
    id: 'preg_reduced_movement',
    group: 'pregnancy',
    level: 'URGENT',
    label: {
      en: 'Baby moving less, or not moving, in the womb',
      hi: 'पेट में बच्चे का कम हिलना या न हिलना',
      ta: 'வயிற்றில் குழந்தை அசைவு குறைவு அல்லது இல்லை'
    },
    kw: ['baby not moving', 'less movement', 'reduced movement', 'not kicking', 'बच्चा हिल नहीं', 'குழந்தை அசைவு']
  },
  {
    id: 'preg_swelling',
    group: 'pregnancy',
    level: 'PRIORITY',
    label: {
      en: 'Swelling of face, hands or feet in pregnancy',
      hi: 'गर्भावस्था में चेहरे, हाथ या पैरों में सूजन',
      ta: 'கர்ப்ப காலத்தில் முகம், கை அல்லது கால் வீக்கம்'
    },
    kw: ['swelling', 'swollen', 'सूजन', 'வீக்கம்']
  },

  // ---- Any age ----------------------------------------------------------------------------------
  {
    id: 'snake_bite',
    group: 'any',
    level: 'URGENT',
    label: { en: 'Snake bite', hi: 'साँप का काटना', ta: 'பாம்பு கடி' },
    kw: ['snake', 'सांप', 'साँप', 'பாம்பு']
  },
  {
    id: 'animal_bite',
    group: 'any',
    level: 'PRIORITY',
    label: { en: 'Dog or other animal bite', hi: 'कुत्ते या जानवर का काटना', ta: 'நாய் அல்லது விலங்கு கடி' },
    kw: ['dog bite', 'bitten by a dog', 'monkey bite', 'animal bite', 'कुत्ते ने काटा', 'நாய் கடி']
  },
  {
    id: 'burn',
    group: 'any',
    level: 'PRIORITY',
    label: { en: 'Burn', hi: 'जलना', ta: 'தீக்காயம்' },
    kw: ['burn', 'scald', 'जल गया', 'जला', 'தீக்காயம்', 'சுட்டு']
  },
  {
    id: 'wound_infected',
    group: 'any',
    level: 'PRIORITY',
    levelFor: (ctx, isYes) => (isYes('fever') ? 'URGENT' : 'PRIORITY'),
    label: {
      en: 'Wound with pus or spreading redness',
      hi: 'घाव में मवाद या फैलती लाली',
      ta: 'சீழ் அல்லது பரவும் சிவப்புடன் காயம்'
    },
    kw: ['pus', 'spreading red', 'infected wound', 'मवाद', 'சீழ்']
  },
  {
    id: 'skin_blisters',
    group: 'any',
    level: 'PRIORITY',
    levelFor: (ctx, isYes) => (ctx.youngInfant || isYes('fever') || isYes('lethargic') ? 'URGENT' : 'PRIORITY'),
    label: {
      en: 'Blistering, peeling or raw skin',
      hi: 'छाले, त्वचा उतरना या कच्ची त्वचा',
      ta: 'கொப்புளங்கள், தோல் உரிதல் அல்லது புண்ணான தோல்'
    },
    kw: ['blister', 'peeling', 'skin peel', 'raw skin', 'skin coming off', 'छाले', 'छाला', 'त्वचा उतर', 'खाल उतर', 'கொப்புளம்', 'தோல் உரி']
  },
  {
    id: 'rash',
    group: 'older',
    level: 'ROUTINE',
    levelFor: (ctx, isYes) => (isYes('fever') ? 'PRIORITY' : 'ROUTINE'),
    label: { en: 'Rash or skin spots', hi: 'दाने या चकत्ते', ta: 'தடிப்பு அல்லது தோல் புள்ளிகள்' },
    kw: ['rash', 'spots', 'itching', 'दाने', 'चकत्ते', 'தடிப்பு', 'அரிப்பு']
  },
  {
    id: 'diarrhoea',
    group: 'older',
    level: 'PRIORITY',
    levelFor: (ctx) => (ctx.under5 ? 'PRIORITY' : 'ROUTINE'),
    label: { en: 'Diarrhoea (loose stools)', hi: 'दस्त', ta: 'வயிற்றுப்போக்கு' },
    kw: ['diarrh', 'loose motion', 'loose stool', 'दस्त', 'வயிற்றுப்போக்கு', 'பேதி']
  },
  {
    id: 'dehydration',
    group: 'older',
    level: 'URGENT',
    label: {
      en: 'Sunken eyes or very dry mouth (dehydration)',
      hi: 'धँसी आँखें या बहुत सूखा मुँह (पानी की कमी)',
      ta: 'குழி விழுந்த கண்கள் அல்லது மிகவும் வறண்ட வாய் (நீரிழப்பு)'
    },
    kw: ['sunken eyes', 'very dry mouth', 'dehydrat', 'धंसी आंखें', 'धँसी आँखें', 'குழி விழுந்த கண்']
  },
  {
    id: 'blood_in_stool',
    group: 'older',
    level: 'PRIORITY',
    label: { en: 'Blood in stool', hi: 'मल में खून', ta: 'மலத்தில் இரத்தம்' },
    kw: ['blood in stool', 'bloody stool', 'मल में खून', 'மலத்தில் ரத்தம்', 'மலத்தில் இரத்தம்']
  }
];

export const SIGN_IDS = DANGER_SIGNS.map((s) => s.id);

const byId = new Map(DANGER_SIGNS.map((s) => [s.id, s]));

export function getSign(id) {
  return byId.get(id);
}

export function signLabel(id, lang = 'en') {
  const sign = byId.get(id);
  if (!sign) return id;
  return sign.label[lang] || sign.label.en;
}

// Vital-sign thresholds (axillary temperature, breaths counted over a full minute).
export const THRESHOLDS = {
  feverC: 37.5,
  lowTempC: 35.5,
  fastBreathingPerMin: 60
};

/** Convert an age the worker typed (value + unit) to days. */
export function ageToDays(value, unit = 'years') {
  const v = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(v) || v < 0) return null;
  const factor = { days: 1, weeks: 7, months: 30, years: 365 }[unit];
  return factor ? Math.round(v * factor) : null;
}

/** Patient context used to decide which signs apply and how serious they are. */
export function patientContext(patient = {}) {
  const ageDays = patient?.ageDays === null || patient?.ageDays === undefined ? null : Number(patient.ageDays);
  const known = ageDays !== null && Number.isFinite(ageDays);
  return {
    ageDays: known ? ageDays : null,
    // Unknown age is treated as a young infant: the strictest checklist.
    youngInfant: !known || ageDays <= MAX_AGE_DAYS,
    under5: known && ageDays < UNDER_FIVE_DAYS,
    pregnant: patient?.pregnant === true && patient?.sex !== 'male'
  };
}

export function signApplies(sign, ctx) {
  switch (sign.group) {
    case 'young_infant':
      return ctx.youngInfant;
    case 'older':
      return !ctx.youngInfant;
    case 'child':
      return !ctx.youngInfant && ctx.under5;
    case 'pregnancy':
      return ctx.pregnant;
    default:
      return true;
  }
}

/** Signs that apply to this patient, in display order. */
export function applicableSigns(patient) {
  const ctx = patientContext(patient);
  return DANGER_SIGNS.filter((s) => signApplies(s, ctx));
}

/** Level of a present sign for this patient, given the other signs (isYes(id) => boolean). */
export function signLevel(sign, ctx, isYes = () => false) {
  return sign.levelFor ? sign.levelFor(ctx, isYes) : sign.level;
}

/** Signs that must be answered for this patient (young infants only). */
export function isRequired(sign, ctx) {
  return Boolean(sign.required) && ctx.youngInfant && signApplies(sign, ctx);
}

// Negation: "no fever", "without pus" (before) · "बुखार नहीं", "காய்ச்சல் இல்லை" (after).
const NEG_BEFORE = /(?:\b(?:no|not|without|denies|never|nahi|nahin)\s+(?:\w+\s+)?|नहीं\s+|बिना\s+)$/;
const NEG_AFTER = /^\s*(?:नहीं|नही|இல்லை|இல்ல|illa|illai|nahi|nahin)/;

/** Negation-aware keyword detection over the worker's typed note, limited to signs that apply. */
export function detectSignsInText(text, patient) {
  const t = ` ${String(text || '').toLowerCase()} `;
  if (!t.trim()) return [];
  const hit = (k) => {
    const kw = k.toLowerCase();
    for (let i = t.indexOf(kw); i !== -1; i = t.indexOf(kw, i + 1)) {
      const before = t.slice(Math.max(0, i - 20), i);
      const after = t.slice(i + kw.length, i + kw.length + 12);
      const negated = (!/^(not|no) /.test(kw) && NEG_BEFORE.test(before)) || NEG_AFTER.test(after);
      if (!negated) return true;
    }
    return false;
  };
  return applicableSigns(patient)
    .filter((s) => (s.kw || []).some(hit))
    .map((s) => s.id);
}
