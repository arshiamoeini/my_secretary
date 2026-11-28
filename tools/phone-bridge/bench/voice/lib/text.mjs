// Persian text normalisation + error rates for the voice benchmark.
//
// Why normalise before scoring: Persian ASR output differs from a reference in
// ways that have nothing to do with hearing the words — ZWNJ vs space, ی vs ي,
// ک vs ك, hamza forms, full-width digits, diacritics, punctuation. Scoring raw
// strings would punish models for orthography and reward them for inventing
// punctuation. Two views of the same text are used, and both are honest about
// what they measure:
//
//   fold(text)   character stream for CER: ZWNJ and spaces are both dropped, so
//                "می‌شود" (dataset) and "می شود" (Whisper) are the same speech
//   words(text)  word list for WER: ZWNJ becomes a separator, so the same pair is
//                two words on both sides
//
// An empty hypothesis against a non-empty reference is always a full error.

const DIACRITICS = /[\u064b-\u0652\u0670\u0640]/g; // harakat, tatweel
const INVISIBLES = /[\u200b\u200d\u200e\u200f\u202a-\u202e\u2060\ufeff]/g; // everything except ZWNJ (U+200C)
const ARABIC_TO_PERSIAN = {
  "\u064a": "\u06cc", // ي → ی
  "\u0643": "\u06a9", // ك → ک
  "\u0624": "\u0648", // ؤ → و
  "\u0625": "\u0627", // إ → ا
  "\u0623": "\u0627", // أ → ا
  "\u0622": "\u0627", // آ → ا
  "\u0629": "\u0647", // ة → ه
  "\u0640": "", // tatweel
};

const NUMBER_WORDS = [
  ["صفر", "0"], ["یك", "1"], ["یک", "1"], ["دو", "2"], ["سه", "3"], ["چهار", "4"], ["پنج", "5"],
  ["شیش", "6"], ["شش", "6"], ["هفت", "7"], ["هشت", "8"], ["نه", "9"],
  ["ده", "10"], ["یازده", "11"], ["دوازده", "12"], ["سیزده", "13"], ["چهارده", "14"], ["پانزده", "15"],
  ["شانزده", "16"], ["هفده", "17"], ["هجده", "18"], ["نوزده", "19"],
  ["بیست", "20"], ["سي", "30"], ["سی", "30"], ["چهل", "40"], ["پنجاه", "50"], ["شصت", "60"],
  ["هفتاد", "70"], ["هشتاد", "80"], ["نود", "90"],
];
const NUMBER_WORD_RE = new RegExp(`(?<![\\u0600-\\u06FF])(${NUMBER_WORDS.map(([w]) => w).join("|")})(?![\\u0600-\\u06FF])`, "g");
const WORD_TO_DIGIT = new Map(NUMBER_WORDS);

/**
 * Spoken numbers and written digits must not count as a mismatch.
 *
 * A caller says "صفر نه سه هفت هفت"; Whisper answers "09377". Both are correct
 * Persian for the same phone number, and a phone call is exactly where this
 * happens, so the digit words are folded to digits on BOTH sides. Multipliers
 * (صد، هزار، میلیون) are deliberately left alone — turning "هزار بار" into a
 * number would hide real errors.
 */
function digitize(text) {
  return text.replace(NUMBER_WORD_RE, (_m, word) => WORD_TO_DIGIT.get(word) ?? word);
}

function base(text, zwnj) {
  let s = String(text ?? "").normalize("NFKC");
  s = s.replace(DIACRITICS, "").replace(INVISIBLES, "");
  s = s.replace(/\u200c/g, zwnj);
  s = [...s].map((ch) => (ch in ARABIC_TO_PERSIAN ? ARABIC_TO_PERSIAN[ch] : ch)).join("");
  s = s.replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  s = s.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  s = s.toLowerCase();
  s = s.replace(/[^\p{Letter}\p{Number} ]+/gu, " ");
  s = s.replace(/\s+/g, " ").trim();
  return digitize(s);
}

/** Character stream used by CER (no spaces, no ZWNJ). */
export function fold(text) {
  return base(text, " ").replace(/ /g, "");
}

/** Word list used by WER (ZWNJ separates). */
export function words(text) {
  const s = base(text, " ");
  return s ? s.split(" ") : [];
}

/** Space-joined canonical form, handy in reports. */
export function normalize(text) {
  return base(text, " ");
}

function editDistance(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n) return m;
  if (!m) return n;
  let prev = new Array(m + 1);
  let curr = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[m];
}

/** Character error rate, 0..1. Empty reference with empty output = 0. */
export function cer(reference, hypothesis) {
  const ref = [...fold(reference)];
  const hyp = [...fold(hypothesis)];
  if (!ref.length) return hyp.length ? 1 : 0;
  return editDistance(ref, hyp) / ref.length;
}

/** Word error rate, 0..1. */
export function wer(reference, hypothesis) {
  const ref = words(reference);
  const hyp = words(hypothesis);
  if (!ref.length) return hyp.length ? 1 : 0;
  return editDistance(ref, hyp) / ref.length;
}

/** 0..1 — how much of the reference survived, cheap and monotone. */
export function containment(reference, hypothesis) {
  const ref = words(reference);
  const hyp = new Set(words(hypothesis));
  if (!ref.length) return 0;
  const hit = ref.filter((w) => hyp.has(w)).length;
  return hit / ref.length;
}

/** Share of letters written in Latin script (1 = the engine answered in English). */
export function latinShare(text) {
  const s = fold(text);
  if (!s) return 0;
  const letters = [...s].filter((c) => /\p{Letter}/u.test(c));
  if (!letters.length) return 0;
  return letters.filter((c) => /[a-z]/.test(c)).length / letters.length;
}

/** Share of letters written in Persian/Arabic script. */
export function persianShare(text) {
  const s = fold(text);
  const letters = [...s].filter((c) => /\p{Letter}/u.test(c));
  if (!letters.length) return 0;
  return letters.filter((c) => /[\u0600-\u06FF]/.test(c)).length / letters.length;
}

/** Latin digits → Persian digits, for display and number comparison. */
export function toPersianDigits(text) {
  const FA = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
  return String(text ?? "").replace(/[0-9]/g, (d) => FA[Number(d)]);
}
