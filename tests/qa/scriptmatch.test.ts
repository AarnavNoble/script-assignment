// Pure tests for the script check: normalization, WER/CER, thresholds, and transcribe()'s failure handling.
// No whisper server needed (fetch is faked or points at a closed port).
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:net';
import {
  normalize, tokens, align, errorRate, scriptMatch, verdictFor, thresholdsFor, describeThreshold,
  SCRIPT_THRESHOLDS, type ScriptThreshold,
} from '@/lib/scriptmatch';
import { transcribe, resample, toWhisperWav, looksLooped, WHISPER_RATE } from '@/lib/transcribe';
import { encodeWav, decodeWav } from '@/lib/wav';
import { LANGUAGES } from '@/db/seed';

describe('normalize', () => {
  it('lowercases, strips Latin punctuation and quotes, collapses whitespace', () => {
    expect(normalize('  "Are you coming to dinner tonight?"  "Yes, but I might be a little late."  ')).toBe(
      'are you coming to dinner tonight yes but i might be a little late');
    expect(normalize('« Tu viens dîner ce soir ? » « Oui ! »', 'fr')).toBe('tu viens dîner ce soir oui');
    expect(normalize('„Kommst du heute Abend?“ „Ja.“', 'de')).toBe('kommst du heute abend ja');
  });

  it('strips CJK punctuation and folds full-width forms (NFKC)', () => {
    expect(normalize('「今晩、夕ご飯を食べに来る？」「うん。」', 'ja')).toBe('今晩 夕ご飯を食べに来る うん');
    expect(normalize('ＡＢＣ１２３', 'en')).toBe('abc123');
  });

  it('strips Devanagari danda and Arabic punctuation; Arabic short vowels and letter variants', () => {
    expect(normalize('हाँ, पर थोड़ी देर हो सकती है।', 'hi')).toBe(normalize('हां पर थोड़ी देर हो सकती है', 'hi'));
    expect(normalize('هل ستأتي؟ «نعم»، لكنني قد أتأخر قليلًا.', 'ar')).toBe('هل ستاتي نعم لكنني قد اتاخر قليلا');
    expect(normalize('فلا تنسَ المظلة', 'ar')).toBe(normalize('فلا تنس المظله', 'ar'));
  });

  it('Turkish dotted capital I lowercases to i, not i + combining dot', () => {
    expect(normalize('İstanbul', 'tr')).toBe('istanbul');
    expect(normalize('IŞIK', 'tr')).toBe('ışık');
  });

  it('keeps a number as one token, including 6:15 and 47.50, but drops currency signs', () => {
    expect(normalize('It costs $47.50, at 6:15.', 'en')).toBe('it costs 47.50 at 6:15');
  });
});

describe('tokens', () => {
  it('words for WER, grapheme clusters without spaces for CER', () => {
    expect(tokens('a bc', 'wer')).toEqual(['a', 'bc']);
    expect(tokens('今晩 来る', 'cer')).toEqual(['今', '晩', '来', 'る']);
    // a Devanagari conjunct + vowel sign is one grapheme cluster, not 3 code points
    expect(tokens('क्षि', 'cer').length).toBeLessThan([...'क्षि'].length);
    expect(tokens('47 kg', 'cer')).toEqual(['47', 'k', 'g']);
  });
});

describe('WER / CER', () => {
  it('counts substitutions, deletions and insertions over the script length', () => {
    expect(align(['a', 'b', 'c'], ['a', 'b', 'c'], 'wer')).toBe(0);
    expect(align(['a', 'b', 'c'], ['a', 'x', 'c'], 'wer')).toBe(1);
    expect(align(['a', 'b', 'c'], ['a', 'c'], 'wer')).toBe(1);
    expect(align(['a', 'b', 'c'], ['a', 'b', 'c', 'd', 'e'], 'wer')).toBe(2);
    expect(align([], ['a'], 'wer')).toBe(1);
    expect(errorRate('the cat sat on the mat', 'the cat sat on a mat', 'en', 'wer')).toBeCloseTo(1 / 6);
    expect(errorRate('the cat sat', '', 'en', 'wer')).toBe(1);
    expect(errorRate('', '', 'en', 'wer')).toBe(0);
  });

  it('punctuation and case differences cost nothing', () => {
    expect(errorRate('The weather forecast says it will rain this afternoon, so bring an umbrella.',
      'The weather forecast says it will rain this afternoon. So bring an umbrella!', 'en', 'wer')).toBe(0);
  });

  it('a digit in the transcript may stand for a spelled-out number in the script', () => {
    expect(errorRate('The total comes to forty-seven dollars and fifty cents, including tax.',
      'The total comes to 47 dollars and 50 cents, including tax.', 'en', 'wer')).toBe(0);
    expect(errorRate('My flight leaves at six fifteen, so I need to be there by four.',
      'My flight leaves at 6:15, so I need to be there by 4.', 'en', 'wer')).toBe(0);
    expect(errorRate('O total ficou em quarenta e sete reais e cinquenta centavos.', 'O total ficou em 47 reais e 50 centavos.', 'pt', 'wer')).toBe(0);
    expect(errorRate('Das macht insgesamt siebenundvierzig Euro und fünfzig Cent.', 'Das macht insgesamt 47 Euro und 50 Cent.', 'de', 'cer')).toBe(0);
    expect(errorRate('今朝、湖のほとりで百羽以上の鳥を数えました。', '今朝、湖のほとりで100羽以上の鳥を数えました。', 'ja', 'cer')).toBe(0);
  });

  it('a number only stands for number words, so it cannot hide a half reading', () => {
    // half reading "in tutto fanno 47": the wildcard covers "quarantasette", not "euro e cinquanta centesimi"
    const it = 'In tutto fanno quarantasette euro e cinquanta centesimi.';
    expect(errorRate(it, 'In tutto fanno 47', 'it', 'wer')).toBeGreaterThan(0.2); // was 0.125 when a number could stand for any words
    expect(scriptMatch(it, 'In tutto fanno 47', 'it').verdict).not.toBe('pass');
    expect(errorRate(it, 'In tutto fanno 47,50 €.', 'it', 'cer')).toBeLessThan(0.25); // the full reading, as Whisper writes it
    expect(errorRate('one two three apples pears plums', '7', 'en', 'wer')).toBeGreaterThanOrEqual(0.5);
    // digits inside an unspaced Japanese word are one unit, not one free wildcard per digit
    const ja = errorRate('お会計は全部で三千四百五十円になりますが、カードでもお支払いいただけます。', 'お会計は全部で3450円になります', 'ja', 'cer');
    expect(ja).toBeGreaterThan(0.35);
    expect(tokens('全部で3450円', 'cer')).toEqual(['全', '部', 'で', '3450', '円']);
  });

  it('Japanese CER: one wrong kanji out of 37 characters', () => {
    const s = '天気予報によると、今日の午後は雨が降るそうなので、傘を持っていってください。';
    const heard = '電気予報によると、今日の午後は雨が降るそうなので、傘を持っていってください。';
    const n = tokens(normalize(s, 'ja'), 'cer').length;
    expect(errorRate(s, heard, 'ja', 'cer')).toBeCloseTo(1 / n);
    expect(errorRate(s, s.replace(/、/g, ' '), 'ja', 'cer')).toBe(0); // spacing / punctuation don't count
  });

  it('Korean CER ignores Whisper spacing differences', () => {
    expect(errorRate('일기예보에 따르면 오늘 오후에 비가 온다고 하니 우산을 챙기세요.', '일기 예보에 따르면 오늘 오후에 비가 온다고 하니 우산을 챙기세요', 'ko', 'cer')).toBe(0);
    expect(errorRate('일기예보에 따르면', '일기 예보에 따르면', 'ko', 'wer')).toBeGreaterThan(0); // WER would punish it
  });

  it('a different sentence is far from the script; half the sentence is ~0.5', () => {
    const s = 'Could you tell me how to get to the nearest train station?';
    expect(errorRate(s, 'I usually make a cup of tea before I start working in the morning.', 'en', 'wer')).toBeGreaterThan(0.8);
    expect(errorRate(s, 'Could you tell me how to', 'en', 'wer')).toBeCloseTo(0.5, 1);
  });
});

describe('thresholds', () => {
  const t: ScriptThreshold = { metric: 'wer', pass: 0.2, fail: 0.4 };
  it('pass at or below pass, fail strictly above fail, review in between', () => {
    expect(verdictFor(0, t)).toBe('pass');
    expect(verdictFor(0.2, t)).toBe('pass');
    expect(verdictFor(0.3, t)).toBe('review');
    expect(verdictFor(0.4, t)).toBe('review');
    expect(verdictFor(0.41, t)).toBe('fail');
    expect(verdictFor(5, { ...t, fail: null })).toBe('review');
  });

  it('every seeded language has thresholds; Swahili never rejects', () => {
    for (const l of LANGUAGES) expect(SCRIPT_THRESHOLDS[l], l).toBeTruthy();
    expect(SCRIPT_THRESHOLDS.sw.fail).toBeNull();
    expect(scriptMatch('Nalazimika kurudisha vitabu hivi maktaba kabla ya Ijumaa.', 'something else entirely', 'sw').verdict).toBe('review');
    expect(thresholdsFor('xx').fail).toBeNull(); // unknown language: review, never reject
    for (const l of LANGUAGES) {
      const th = SCRIPT_THRESHOLDS[l];
      if (th.fail !== null) expect(th.fail, l).toBeGreaterThanOrEqual(th.pass);
    }
  });

  it('scriptMatch uses the language metric and returns its thresholds', () => {
    const m = scriptMatch('今晩、夕ご飯を食べに来る？', '今晩、夕ご飯を食べに来る', 'ja');
    expect(m).toMatchObject({ metric: SCRIPT_THRESHOLDS.ja.metric, errorRate: 0, verdict: 'pass' });
    expect(describeThreshold(SCRIPT_THRESHOLDS.sw)).toMatch(/never reject/);
  });

  it('correct, wrong and partial readings land in pass / fail for English', () => {
    const s = 'Could you tell me how to get to the nearest train station?';
    expect(scriptMatch(s, 'Could you tell me how to get to the nearest train station', 'en').verdict).toBe('pass');
    expect(scriptMatch(s, 'I usually make a cup of tea before I start working in the morning.', 'en').verdict).toBe('fail');
    expect(scriptMatch(s, '', 'en').verdict).toBe('fail');
  });
});

describe('transcribe', () => {
  const wav = encodeWav({ sampleRate: 48000, samples: new Float32Array(48000).map((_, i) => 0.3 * Math.sin(i / 10)) });
  const ok = (text: string) => async () => new Response(JSON.stringify({ text }), { status: 200 });

  it('returns null when WHISPER_URL is unset (check off), without calling anything', async () => {
    let called = 0;
    const prev = process.env.WHISPER_URL;
    delete process.env.WHISPER_URL;
    try {
      expect(await transcribe(wav, 'en', { fetchImpl: (async () => { called++; return new Response('{}'); }) as typeof fetch })).toBeNull();
    } finally {
      if (prev !== undefined) process.env.WHISPER_URL = prev;
    }
    expect(called).toBe(0);
  });

  it('returns null when the server is down (connection refused), after one retry', async () => {
    const port = await new Promise<number>((res) => { const s = createServer(); s.listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
    const t0 = Date.now();
    expect(await transcribe(wav, 'en', { url: `http://127.0.0.1:${port}`, timeoutMs: 2000 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it('returns null on a hung server (timeout), on 5xx and on a reply without text', async () => {
    const hang = (async (_u: unknown, init?: RequestInit) => new Promise<Response>((_, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as typeof fetch;
    expect(await transcribe(wav, 'en', { url: 'http://x', timeoutMs: 50, fetchImpl: hang })).toBeNull();
    expect(await transcribe(wav, 'en', { url: 'http://x', fetchImpl: (async () => new Response('busy', { status: 503 })) as typeof fetch })).toBeNull();
    expect(await transcribe(wav, 'en', { url: 'http://x', fetchImpl: (async () => new Response('{"error":"bad"}')) as typeof fetch })).toBeNull();
  });

  it('retries once: a single failure still yields a transcript; sends 16 kHz mono WAV and the language', async () => {
    let calls = 0;
    let sent: { rate?: number; lang?: string } = {};
    const flaky = (async (_u: unknown, init?: RequestInit) => {
      calls++;
      if (calls === 1) throw new Error('ECONNRESET');
      const form = init!.body as FormData;
      const file = form.get('file') as Blob;
      sent = { rate: decodeWav(Buffer.from(await file.arrayBuffer())).sampleRate, lang: String(form.get('language')) };
      return new Response(JSON.stringify({ text: ' Hello there.\n' }));
    }) as typeof fetch;
    const r = await transcribe(wav, 'de', { url: 'http://x', fetchImpl: flaky });
    expect(r?.text).toBe('Hello there.');
    expect(calls).toBe(2);
    expect(sent).toEqual({ rate: WHISPER_RATE, lang: 'de' });
  });

  it('re-decodes once when the greedy transcript is a repetition loop', async () => {
    const replies = ['तो तो तो तो तो तो तो तो तो तो तो तो तो तो तो तो तो तो तो तो', 'आज शाम को बारिश होने की संभावना है'];
    let calls = 0;
    const f = (async () => new Response(JSON.stringify({ text: replies[calls++] }))) as typeof fetch;
    expect((await transcribe(wav, 'hi', { url: 'http://x', fetchImpl: f }))?.text).toBe(replies[1]);
    expect(calls).toBe(2);
    expect(looksLooped(replies[0])).toBe(true);
    expect(looksLooped('The weather forecast says it will rain this afternoon, so bring an umbrella.')).toBe(false);
    let n = 0;
    await transcribe(wav, 'en', { url: 'http://x', fetchImpl: (async () => { n++; return ok('Fine.')(); }) as typeof fetch });
    expect(n).toBe(1); // a normal transcript: no second call
  });

  it('returns null for undecodable audio', async () => {
    expect(await transcribe(Buffer.from('not a wav'), 'en', { url: 'http://x', fetchImpl: ok('x') as typeof fetch })).toBeNull();
  });
});

describe('resample', () => {
  const sine = (sr: number, f: number, n: number) => new Float32Array(n).map((_, i) => 0.5 * Math.sin((2 * Math.PI * f * i) / sr));
  const peak = (x: Float32Array) => x.slice(200, -200).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  it('48 kHz -> 16 kHz keeps a 1 kHz tone and removes a 12 kHz one (no aliasing)', () => {
    expect(peak(resample(sine(48000, 1000, 48000), 48000, 16000))).toBeCloseTo(0.5, 2);
    expect(peak(resample(sine(48000, 12000, 48000), 48000, 16000))).toBeLessThan(0.01);
    expect(resample(sine(48000, 1000, 48000), 48000, 16000).length).toBe(16000);
  });
  it('toWhisperWav: stereo / any rate -> 16 kHz mono', () => {
    const out = decodeWav(toWhisperWav(encodeWav({ sampleRate: 44100, samples: sine(44100, 440, 44100) })));
    expect(out).toMatchObject({ sampleRate: 16000, channels: 1 });
    expect(out.samples.length).toBe(16000);
  });
});
