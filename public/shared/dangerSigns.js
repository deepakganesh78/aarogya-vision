// Young-infant (0-59 days) danger signs, adapted from WHO "Management of the sick young
// infant aged up to 2 months" (IMCI chart booklet, 2019) and India's IMNCI chart booklet.
// PROTOTYPE CONTENT: wording and thresholds must be signed off by a clinician before field use.
// Hindi/Tamil labels are drafts that need native-speaker review.

export const RULES_VERSION = 'young-infant-2026.11-draft';

export const LEVELS = ['ROUTINE', 'PRIORITY', 'URGENT'];

export const MAX_AGE_DAYS = 59;

export const DANGER_SIGNS = [
  {
    id: 'not_feeding_well',
    level: 'URGENT',
    required: true,
    label: {
      en: 'Not able to feed, or stopped feeding well (not sucking)',
      hi: 'दूध नहीं पी पा रहा, या ठीक से दूध पीना बंद कर दिया (चूस नहीं रहा)',
      ta: 'பால் குடிக்க முடியவில்லை, அல்லது சரியாகப் பால் குடிப்பதை நிறுத்திவிட்டது (உறிஞ்சவில்லை)'
    }
  },
  {
    id: 'convulsions',
    level: 'URGENT',
    required: true,
    label: { en: 'Convulsions (fits)', hi: 'दौरे / झटके आना', ta: 'வலிப்பு' }
  },
  {
    id: 'fast_breathing',
    level: 'URGENT',
    required: true,
    label: {
      en: 'Fast breathing (60 or more breaths in one minute)',
      hi: 'तेज़ साँस (एक मिनट में 60 या अधिक)',
      ta: 'வேகமான மூச்சு (ஒரு நிமிடத்தில் 60 அல்லது அதற்கு மேல்)'
    }
  },
  {
    id: 'severe_chest_indrawing',
    level: 'URGENT',
    required: true,
    label: {
      en: 'Severe chest indrawing',
      hi: 'साँस लेते समय छाती का ज़्यादा अंदर धँसना',
      ta: 'மூச்சுவிடும்போது மார்பு கடுமையாக உள்ளிழுத்தல்'
    }
  },
  {
    id: 'fever',
    level: 'URGENT',
    required: true,
    label: {
      en: 'Fever: 37.5 °C or above, or feels hot',
      hi: 'बुखार: 37.5 °C या अधिक, या छूने पर गरम',
      ta: 'காய்ச்சல்: 37.5 °C அல்லது அதற்கு மேல், அல்லது தொட்டால் சூடாக உள்ளது'
    }
  },
  {
    id: 'low_temperature',
    level: 'URGENT',
    required: true,
    label: {
      en: 'Low body temperature: below 35.5 °C, or feels cold',
      hi: 'शरीर का कम तापमान: 35.5 °C से कम, या छूने पर ठंडा',
      ta: 'குறைந்த உடல் வெப்பநிலை: 35.5 °C க்குக் கீழ், அல்லது தொட்டால் குளிர்ச்சியாக உள்ளது'
    }
  },
  {
    id: 'low_movement',
    level: 'URGENT',
    required: true,
    label: {
      en: 'Moves only when stimulated, or does not move at all',
      hi: 'केवल छूने/हिलाने पर ही हिलता है, या बिल्कुल नहीं हिलता',
      ta: 'தூண்டினால் மட்டுமே அசைகிறது, அல்லது அசையவே இல்லை'
    }
  },
  {
    id: 'umbilical_redness_spreading',
    level: 'URGENT',
    required: true,
    label: {
      en: 'Redness around the navel spreading to the skin',
      hi: 'नाभि के आसपास लाली जो त्वचा पर फैल रही है',
      ta: 'தொப்புளைச் சுற்றி உள்ள சிவப்பு தோலுக்குப் பரவுகிறது'
    }
  },
  {
    id: 'umbilicus_red_or_pus',
    level: 'PRIORITY',
    required: false,
    label: {
      en: 'Navel red or draining pus (redness not spreading)',
      hi: 'नाभि लाल है या उसमें से मवाद निकल रहा है (लाली फैल नहीं रही)',
      ta: 'தொப்புள் சிவந்துள்ளது அல்லது சீழ் வடிகிறது (சிவப்பு பரவவில்லை)'
    }
  },
  {
    id: 'many_skin_pustules',
    level: 'URGENT',
    required: true,
    label: {
      en: '10 or more skin pustules, or a big boil',
      hi: 'त्वचा पर 10 या अधिक फुंसियाँ, या एक बड़ा फोड़ा',
      ta: 'தோலில் 10 அல்லது அதற்கு மேற்பட்ட சீழ்க் கொப்புளங்கள், அல்லது ஒரு பெரிய கட்டி'
    }
  },
  {
    id: 'few_skin_pustules',
    level: 'PRIORITY',
    required: false,
    label: {
      en: 'A few skin pustules (fewer than 10)',
      hi: 'त्वचा पर कुछ फुंसियाँ (10 से कम)',
      ta: 'தோலில் சில சீழ்க் கொப்புளங்கள் (10 க்குக் குறைவு)'
    }
  },
  {
    id: 'severe_jaundice',
    level: 'URGENT',
    required: true,
    label: {
      en: 'Yellow palms and soles, or yellow skin in the first 24 hours of life',
      hi: 'हथेलियाँ और तलवे पीले, या जन्म के पहले 24 घंटों में त्वचा पीली',
      ta: 'உள்ளங்கைகளும் உள்ளங்கால்களும் மஞ்சளாக உள்ளன, அல்லது பிறந்த முதல் 24 மணி நேரத்தில் தோல் மஞ்சளாக உள்ளது'
    }
  },
  {
    id: 'jaundice',
    level: 'PRIORITY',
    required: false,
    label: {
      en: 'Yellow eyes or skin (palms and soles not yellow)',
      hi: 'आँखें या त्वचा पीली (हथेलियाँ और तलवे पीले नहीं)',
      ta: 'கண்கள் அல்லது தோல் மஞ்சளாக உள்ளது (உள்ளங்கை, உள்ளங்கால் மஞ்சள் இல்லை)'
    }
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
