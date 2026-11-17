// Did the contributor read the script? Compare the script text with a speech-to-text transcript.
// Pure: no I/O. lib/qa.ts feeds it the script body and lib/transcribe.ts's transcript.
//
// The error rate is an edit distance (substitutions + deletions + insertions) over the script's
// length, in words (WER) for space-delimited languages or in characters (CER, grapheme clusters)
// where word boundaries are unreliable: Japanese has none, and Whisper's spacing in Korean and its
// word splits in Indic scripts don't follow the script's. Which metric each language uses, and its
// thresholds, come from the measured evaluation in results/script-check.md (sim/script-eval.ts).

export type Metric = 'wer' | 'cer';
export type ScriptVerdict = 'pass' | 'review' | 'fail';
/** pass: errorRate <= pass. fail: errorRate > fail. In between: review. fail = null: never reject. */
export type ScriptThreshold = {
  metric: Metric; pass: number; fail: number | null; note?: string;
  /** Check off for this language (reason): QA doesn't transcribe, records the skip, decides on audio alone. */
  skip?: string;
};

/**
 * Per-language thresholds on character error rate (CER), from the measured evaluation in
 * results/script-check.md (`npm run script-eval`; Whisper ggml-small, macOS TTS readings: correct,
 * slow, fast + noisy; wrong sentence, half sentence, wrong language).
 * How they were chosen: per language, a grid search over (pass, fail) in 0.05 steps with a review band
 * of at least 0.1, minimizing 20 per wrongly rejected correct reading + 10 per wrongly approved wrong
 * reading + 1 per take sent to review; ties go to the widest margin. CER for every language: it had
 * the fewest wrong rejections in cross-validation (robust to Whisper's word splits: German compounds,
 * Korean spacing, Indic word breaks, Turkish suffixes). For reference, a wrong sentence or language
 * scores ~0.8-1.0 and a half reading ~0.45-0.6. Regenerate with `npm run script-eval` and copy its
 * "Chosen thresholds" table here.
 */
export const SCRIPT_THRESHOLDS: Record<string, ScriptThreshold> = {
  en: { metric: 'cer', pass: 0.15, fail: 0.55 },
  es: { metric: 'cer', pass: 0.1, fail: 0.3 },
  // Hindi: correct readings already score CER ~0.3 (spelling variants, some loops), hence the high bar
  hi: { metric: 'cer', pass: 0.45, fail: 0.6 },
  pt: { metric: 'cer', pass: 0.15, fail: 0.35 },
  fr: { metric: 'cer', pass: 0.3, fail: 0.4 },
  de: { metric: 'cer', pass: 0.35, fail: 0.5 },
  ar: { metric: 'cer', pass: 0.1, fail: 0.35 },
  // Bengali: Whisper-small returns no usable Bengali (junk or other scripts; CER ~1.0 on correct
  // readings, ~5 s per take), so the check is off: decided on the audio checks, the skip is recorded.
  bn: { metric: 'cer', pass: 0, fail: null, skip: 'Whisper-small cannot transcribe Bengali' },
  ja: { metric: 'cer', pass: 0.4, fail: 0.5 },
  // Korean: Whisper-small hallucinates on some fast/noisy Korean takes, so rejection needs CER > 1 (a long hallucination)
  ko: { metric: 'cer', pass: 0.3, fail: 1 },
  id: { metric: 'cer', pass: 0.2, fail: 0.4 },
  tr: { metric: 'cer', pass: 0.25, fail: 0.35 },
  vi: { metric: 'cer', pass: 0.2, fail: 0.3 },
  it: { metric: 'cer', pass: 0.15, fail: 0.35 },
  pl: { metric: 'cer', pass: 0.2, fail: 0.4 },
  // Swahili: no TTS voice on this machine, so untested. Never auto-reject; anything that isn't a
  // near-exact match goes to a human.
  sw: { metric: 'cer', pass: 0.1, fail: null, note: 'untested (no TTS voice): review, never reject' },
};

/** Languages whose scripts are not in the table (shouldn't happen) get a review-only policy. */
export const FALLBACK_THRESHOLD: ScriptThreshold = { metric: 'wer', pass: 0.15, fail: null, note: 'no thresholds for this language: review, never reject' };

export const thresholdsFor = (lang: string): ScriptThreshold => SCRIPT_THRESHOLDS[lang] ?? FALLBACK_THRESHOLD;

/**
 * Number words per language (plus currency words, which Whisper writes as symbols: "R$ 47,50").
 * Scripts spell numbers out ("forty-seven", "quarenta e sete", "四十七")
 * but Whisper writes digits ("47", "47,50"), so a number in the transcript may stand for a run of
 * script units that are number words (including "and"-type connectors), and nothing else: a wrong
 * or half reading can't use a number to excuse ordinary words. Matched against normalized words
 * (whole word). Not exhaustive; a number word missing here just costs its normal edit distance.
 */
const NUMBER_WORDS: Record<string, RegExp> = {
  en: /^(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\p{L}+teen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|and|half|quarter|past|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|\p{L}+teenth|\p{L}+tieth|point|percent|o'?clock|dollars?|cents?|euros?|pounds?|pence)$/u,
  es: /^(cero|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieci\p{L}+|veinte|veinti\p{L}+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|\p{L}*cientos|\p{L}*cientas|quinientos|quinientas|mil|millón|millones|y|media|cuarto|primero|primer|segundo|tercero|tercer|euros?|céntimos?|pesos?|dólares|centavos?)$/u,
  pt: /^(zero|um|uma|dois|duas|três|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|catorze|quatorze|quinze|dezesseis|dezasseis|dezessete|dezassete|dezoito|dezenove|dezanove|vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa|cem|cento|\p{L}*centos|\p{L}*centas|quinhentos|mil|milhão|milhões|e|meia|meio|reais|real|centavos?|euros?)$/u,
  fr: /^(zéro|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingt|vingts|trente|quarante|cinquante|soixante|cent|cents|mille|million|millions|et|demi|demie|quart|premier|première|\p{L}+ième|euros?|centimes?)$/u,
  de: /^((ein|eins|eine|zwei|drei|vier|fünf|sechs|sech|sieben|sieb|acht|neun|zehn|elf|zwölf|zwanzig|dreißig|vierzig|fünfzig|sechzig|siebzig|achtzig|neunzig|hundert|tausend|und)+(te|ten|ter|tes|tem)?|null|million|millionen|halb|halbe|viertel|euro|cent|prozent)$/u,
  it: /^((zero|uno|una|un|due|tre|tré|quattro|cinque|sei|sette|otto|nove|dieci|undici|dodici|tredici|quattordici|quindici|sedici|diciassette|diciotto|diciannove|venti|vent|trenta|trent|quaranta|quarant|cinquanta|cinquant|sessanta|sessant|settanta|settant|ottanta|ottant|novanta|novant|cento|mille|mila|milione|milioni)+|e|mezzo|mezza|euro|centesimi|centesimo)$/u,
  pl: /^(zero|jeden|jedna|jedno|dwa|dwie|trzy|cztery|pięć|sześć|siedem|osiem|dziewięć|dziesięć|\p{L}+naście|dwadzieścia|trzydzieści|czterdzieści|\p{L}+dziesiąt|sto|dwieście|trzysta|czterysta|\p{L}+set|tysiąc|tysiące|tysięcy|milion|i|wpół|złotych|złote|złoty|groszy|pierwsz\p{L}*|drug\p{L}*|trzec\p{L}*|czwart\p{L}*|piąt\p{L}*|szóst\p{L}*|siódm\p{L}*|ósm\p{L}*)$/u,
  tr: /^(sıfır|bir|iki|üç|dört|beş|altı|yedi|sekiz|dokuz|on|yirmi|otuz|kırk|elli|altmış|yetmiş|seksen|doksan|yüz|bin|milyon|buçuk|lira|kuruş)$/u,
  id: /^(nol|satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh|sebelas|belas|puluh|ratus|ribu|juta|seratus|seribu|setengah|ke\p{L}+|rupiah)$/u,
  vi: /^(không|một|mốt|hai|ba|bốn|tư|năm|lăm|sáu|bảy|tám|chín|mười|mươi|trăm|nghìn|ngàn|triệu|linh|lẻ|rưỡi|đồng)$/u,
  ar: /^و?(صفر|واحد|واحده|اثنان|اثنين|اثنتان|ثلاث|ثلاثه|اربع|اربعه|خمس|خمسه|ست|سته|سبع|سبعه|ثمان|ثماني|ثمانيه|تسع|تسعه|عشر|عشره|عشرون|عشرين|ثلاثون|ثلاثين|اربعون|اربعين|خمسون|خمسين|ستون|ستين|سبعون|سبعين|ثمانون|ثمانين|تسعون|تسعين|مئه|مائه|مئتان|مئتين|الف|الاف|مليون|نصف|ربع)$/u,
  // Devanagari / Bengali lists are written in normalized form (no nukta, chandrabindu -> anusvara)
  hi: /^(शून्य|एक|दो|तीन|चार|पांच|छह|छः|सात|आठ|नौ|दस|ग्यारह|बारह|तेरह|चौदह|पंद्रह|सोलह|सत्रह|अठारह|उन्नीस|बीस|इक्कीस|बाईस|तेईस|चौबीस|पच्चीस|तीस|पैंतीस|चालीस|पैंतालीस|सैंतालीस|पचास|साठ|सत्तर|अस्सी|नब्बे|सौ|हजार|लाख|करोड|डेढ|ढाई|साढे|सवा|पौने|रुपये|रुपए|रुपया|पैसे)$/u,
  bn: /^(শূন্য|এক|দুই|তিন|চার|পাঁচ|পাংচ|ছয়|সাত|আট|নয়|দশ|বিশ|ত্রিশ|চল্লিশ|পঞ্চাশ|ষাট|সত্তর|আশি|নব্বই|শ|একশ|হাজার|লাখ|সাড়ে|দেড়|আড়াই)$/u,
  ko: /^([영일이삼사오육칠팔구십백천만]+|하나|둘|셋|넷|다섯|여섯|일곱|여덟|아홉|열|스물|서른|마흔|쉰|예순|일흔|여든|아흔|한|두|세|네)(시|분|살|개|명|번|원|시간|째)?$/u,
};
/** Japanese has no spaces: number kanji are flagged per character. */
const JA_NUMBER_CHARS = /^[〇零一二三四五六七八九十百千万億半円]$/u;

const NUMBER = /^\p{Nd}+(?:[.,:]\p{Nd}+)*$/u;
const NUMBER_RUN = /(\p{Nd}+(?:[.,:]\p{Nd}+)*)/u;
const isNumber = (t: string) => NUMBER.test(t);

/** Most script number-word units one digit group may stand for ("47,50" = 2 groups). */
const UNITS_PER_GROUP = { wer: 3, cer: 18 } as const; // 18: "siebenundvierzig" is 16 characters
const maxSpan = (num: string, metric: Metric) => num.split(/[.,:]/).length * UNITS_PER_GROUP[metric];
/**
 * Normalize for comparison: NFKC (full-width forms, ligatures, composed accents), lowercase
 * (Turkish dotted/dotless i aware), language-specific spelling variants ASR output doesn't keep
 * (Arabic short vowels and letter variants, Indic nukta/chandrabindu), and punctuation and symbols
 * removed in every script (Latin, CJK 、。「」, Arabic ، ؟, Devanagari ।, quotes « » „ “). Punctuation
 * between two digits is kept ("6:15", "47.50") so a number stays one token. Whitespace collapsed.
 */
export function normalize(text: string, lang = 'en'): string {
  let s = text.normalize('NFKC');
  s = lang === 'tr' || lang === 'az' ? s.toLocaleLowerCase('tr') : s.toLowerCase();
  if (lang === 'ar') {
    s = s
      .replace(/[ً-ٰٟـ]/g, '') // harakat, superscript alef, tatweel
      .replace(/[آأإٱ]/g, 'ا') // alef with madda/hamza/wasla -> alef
      .replace(/ى/g, 'ي') // alef maksura -> yeh
      .replace(/ة/g, 'ه'); // teh marbuta -> heh
  } else if (lang === 'hi' || lang === 'bn') {
    s = s
      .normalize('NFD')
      .replace(/[़়]/g, '') // nukta (ज़ vs ज)
      .replace(/ँ/g, 'ं') // chandrabindu -> anusvara (Devanagari)
      .replace(/ঁ/g, 'ং') // chandrabindu -> anusvara (Bengali)
      .normalize('NFC');
  }
  s = s.replace(/(?<!\p{Nd})[\p{P}\p{S}]|[\p{P}\p{S}](?!\p{Nd})/gu, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('und', { granularity: 'grapheme' }) : null;
const graphemes = (w: string) => (segmenter ? [...segmenter.segment(w)].map((g) => g.segment) : [...w]);

export type Units = { units: string[]; numberWord: boolean[] };

/**
 * Comparison units: words for WER; grapheme clusters for CER (spaces dropped). A digit run is one
 * unit either way (also inside an unspaced Japanese / Korean word). `numberWord[i]` marks units that
 * belong to a spelled-out number (see NUMBER_WORDS).
 */
export function units(normalized: string, metric: Metric, lang = 'en'): Units {
  const re = NUMBER_WORDS[lang];
  const out: Units = { units: [], numberWord: [] };
  for (const w of normalized.split(' ').filter(Boolean)) {
    const isNumWord = !!re && re.test(w);
    if (metric === 'wer') { out.units.push(w); out.numberWord.push(isNumWord); continue; }
    for (const part of w.split(NUMBER_RUN).filter(Boolean)) {
      if (isNumber(part)) { out.units.push(part); out.numberWord.push(false); continue; }
      for (const g of graphemes(part)) {
        out.units.push(g);
        out.numberWord.push(isNumWord || (lang === 'ja' && JA_NUMBER_CHARS.test(g)));
      }
    }
  }
  return out;
}

export const tokens = (normalized: string, metric: Metric, lang = 'en'): string[] => units(normalized, metric, lang).units;

/**
 * Edit distance between the script units (ref) and the transcript units (hyp), where a number in
 * the transcript may also replace a run of 1..maxSpan consecutive script number-word units at no
 * cost (`numberWord`, from units()). Without `numberWord` no unit is a number word.
 */
export function align(ref: string[], hyp: string[], metric: Metric = 'wer', numberWord?: boolean[]): number {
  const R = ref.length, H = hyp.length;
  // run[i] = how many number-word units end at ref position i (consecutively)
  const run = new Int32Array(R + 1);
  for (let i = 1; i <= R; i++) run[i] = numberWord?.[i - 1] ? run[i - 1] + 1 : 0;
  let prev = new Float64Array(R + 1);
  let cur = new Float64Array(R + 1);
  for (let i = 0; i <= R; i++) prev[i] = i; // j = 0: delete all ref units
  for (let j = 1; j <= H; j++) {
    const h = hyp[j - 1];
    const span = isNumber(h) ? maxSpan(h, metric) : 0;
    cur[0] = j;
    for (let i = 1; i <= R; i++) {
      let best = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + (ref[i - 1] === h ? 0 : 1));
      for (let k = 1; k <= span && k <= run[i]; k++) best = Math.min(best, prev[i - k]);
      cur[i] = best;
    }
    [prev, cur] = [cur, prev];
  }
  return prev[R];
}

/** Error rate of `heard` against `expected` with the given metric. Empty script: 0 if nothing was heard, else 1. */
export function errorRate(expected: string, heard: string, lang: string, metric: Metric): number {
  const ref = units(normalize(expected, lang), metric, lang);
  const hyp = units(normalize(heard, lang), metric, lang);
  if (!ref.units.length) return hyp.units.length ? 1 : 0;
  return align(ref.units, hyp.units, metric, ref.numberWord) / ref.units.length;
}

export type ScriptMatch = {
  metric: Metric;
  errorRate: number;
  verdict: ScriptVerdict;
  thresholds: ScriptThreshold;
};

export function verdictFor(rate: number, t: ScriptThreshold): ScriptVerdict {
  if (t.fail !== null && rate > t.fail) return 'fail';
  return rate <= t.pass ? 'pass' : 'review';
}

export function scriptMatch(expected: string, heard: string, lang: string, table: Record<string, ScriptThreshold> = SCRIPT_THRESHOLDS): ScriptMatch {
  const t = table[lang] ?? FALLBACK_THRESHOLD;
  const rate = errorRate(expected, heard, lang, t.metric);
  return { metric: t.metric, errorRate: rate, verdict: verdictFor(rate, t), thresholds: t };
}

/** Human-readable bands for the stored check, e.g. "pass <= 0.2; fail > 0.4 (wer)". */
export function describeThreshold(t: ScriptThreshold): string {
  return `pass <= ${t.pass}; ${t.fail === null ? 'never reject, review above' : `review <= ${t.fail}; fail > ${t.fail}`} (${t.metric}${t.note ? `; ${t.note}` : ''})`;
}
