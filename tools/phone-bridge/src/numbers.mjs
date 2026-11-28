// Iranian phone number normalization.
//
// Android's `tel:` URI accepts E.164 (+98912...), but humans (and the model)
// write 09121234567, 9121234567, +989121234567, 00989121234567, or Persian and
// Arabic digits. We canonicalize once here so the dialer never has to guess.

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

export function toLatinDigits(value) {
  return String(value ?? "").replace(/[۰-۹٠-٩]/g, (ch) => {
    const p = PERSIAN_DIGITS.indexOf(ch);
    if (p >= 0) return String(p);
    return String(ARABIC_DIGITS.indexOf(ch));
  });
}

function fail(input, reason) {
  return { ok: false, input: String(input ?? ""), reason };
}

/**
 * Normalize any common Iranian number spelling to a canonical form.
 *
 * @returns {{ok: true, input: string, national: string, e164: string, kind: "mobile"|"landline", digits: string}
 *          | {ok: false, input: string, reason: string}}
 */
export function normalizeIranNumber(input) {
  const original = String(input ?? "").trim();
  if (!original) return fail(original, "empty number");

  let s = toLatinDigits(original).replace(/[\s\-()._/]/g, "");
  if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith("00")) s = s.slice(2);
  if (!/^\d+$/.test(s)) return fail(original, "contains non-digit characters");

  // +98 / 0098 / 98 international prefix.
  if (s.length === 12 && s.startsWith("98")) s = `0${s.slice(2)}`;
  // Bare national number without the trunk 0 (9121234567 / 2112345678).
  else if (s.length === 10) s = `0${s}`;

  if (s.length !== 11) {
    return fail(original, `expected 11 digits after normalization, got ${s.length}`);
  }

  const kind = /^09\d{9}$/.test(s) ? "mobile" : /^0[1-8]\d{9}$/.test(s) ? "landline" : null;
  if (!kind) return fail(original, "not a valid Iranian mobile (09xxxxxxxxx) or landline (0xx...) number");

  return {
    ok: true,
    input: original,
    national: s,
    e164: `+98${s.slice(1)}`,
    digits: s.slice(1),
    kind,
  };
}

export function sameNumber(a, b) {
  const na = normalizeIranNumber(a);
  const nb = normalizeIranNumber(b);
  return na.ok && nb.ok && na.national === nb.national;
}
