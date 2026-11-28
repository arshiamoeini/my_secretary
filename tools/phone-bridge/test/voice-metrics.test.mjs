// Self-tests for the voice scorer.
//
// The ranking in bench/voice is only trustworthy if the measurement itself is
// boring and correct, so the Persian normaliser and the error rates are pinned
// here — offline, with cases where a naive implementation would lie.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cer, containment, fold, latinShare, persianShare, toPersianDigits, words, wer } from "../bench/voice/lib/text.mjs";
import { pcm16ToWav, wavBytes } from "../src/local/aval.mjs";
import { probeWav } from "../src/local/wav.mjs";

test("fold unifies the orthography that is not a recognition error", () => {
  // ZWNJ vs space, ی/ي, ک/ك, hamza forms, diacritics, punctuation, case
  assert.equal(fold("می‌شود"), fold("مي شود"));
  assert.equal(fold("نمی‌تواند"), fold("نميتواند"));
  assert.equal(fold("قرآن"), fold("قراٰن"));
  assert.equal(fold("۱۴۰۴/۱۱/۱۴"), fold("1404-11-14"));
  assert.equal(fold("سلام!"), fold("   سلام  "));
});

test("fold still separates different words", () =>
  assert.notEqual(fold("می شود"), fold("نمی شود")));

test("identical speech scores zero error", () => {
  const ref = "سلام، وقت بخیر. شما با دفتر مدرسه صحبت می‌کنید.";
  assert.equal(cer(ref, ref), 0);
  assert.equal(wer(ref, ref), 0);
});

test("CER scales with real mistakes, punctuation is invisible", () => {
  const ref = "شماره تماس من ۰۹۱۲۳۴۵۶۷۸۹ است";
  assert.equal(cer(ref, "شماره تماس من 09123456789 است."), 0, "digits and punctuation normalise away");
  const oneChar = "کتاب را خواندم";
  const wrong = "کتاب را نخوندم";
  assert.ok(cer(oneChar, wrong) > 0 && cer(oneChar, wrong) < 0.4, `cer=${cer(oneChar, wrong)}`);
  assert.ok(wer(oneChar, wrong) > cer(oneChar, wrong), "a broken word costs more as WER");
});

test("an empty hypothesis is a full error, never a zero", () => {
  assert.equal(cer("سلام دوست عزیز", ""), 1);
  assert.equal(wer("سلام دوست عزیز", ""), 1);
  assert.equal(containment("سلام دوست عزیز", ""), 0);
});

test("a hallucinated transcript scores worse than a partial one", () => {
  const ref = "بله فردا ساعت نه می رسم";
  const partial = "بله فردا ساعت نه";
  const invented = "متشکرم خدانگهدار لطفا دوباره تماس بگیرید";
  assert.ok(cer(ref, invented) > cer(ref, partial), `${cer(ref, invented)} !> ${cer(ref, partial)}`);
  assert.ok(containment(ref, partial) > containment(ref, invented));
});

test("Latin answers are caught by the script check", () => {
  assert.equal(latinShare("hello please call back"), 1);
  assert.equal(latinShare("سلام وقت بخیر"), 0);
  assert.ok(persianShare("سلام وقت بخیر") > 0.99);
  assert.ok(persianShare("hello world") === 0);
  assert.ok(latinShare("سلام hello") > 0.2);
});

test("Persian digits compare equal to Latin digits", () => {
  assert.equal(toPersianDigits("0912"), "۰۹۱۲");
  assert.equal(fold("۰۹۱۲۳۴۵۶۷۸۹"), fold(toPersianDigits("09123456789")));
});

test("spoken numbers match written digits, both directions", () => {
  // the real call case: the script spells the number, the ASR writes numerals
  assert.equal(cer("شماره ما صفر نه سه هفت هفت صفر صفر صفر صفر صفر صفر است", "شماره ما 09377000000 است"), 0);
  assert.equal(cer("ساعت ۹ و ۳۰ دقیقه", "ساعت نه و سی دقیقه"), 0);
  // number words must not swallow other words
  assert.equal(words("سیب قرمز").length, 2);
  assert.notEqual(fold("یک سیب"), fold("۲ سیب"));
});

test("pcm16ToWav produces a WAV the bridge itself can probe", () => {
  const pcm = Buffer.alloc(12000 * 2); // 0.5 s at 24 kHz, mono 16-bit
  for (let i = 0; i < 12000; i += 1) pcm.writeInt16LE(Math.round(Math.sin(i / 20) * 8000), i * 2);
  const wav = pcm16ToWav(pcm, 24000);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.length, 44 + pcm.length);
  assert.ok(Math.abs(wavBytes(wav) - 0.5) < 0.001, `wavBytes=${wavBytes(wav)}`);
});

test("a header-only file is silent, exactly what speak() must refuse", () => {
  const empty = pcm16ToWav(Buffer.alloc(0), 24000);
  assert.equal(wavBytes(empty), 0);
  const probe = probeWavFromBuffer(empty);
  assert.equal(probe.silent, true);
});

/** probeWav reads from disk; write the buffer once through a temp file. */
function probeWavFromBuffer(buffer) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wav-probe-")), "x.wav");
  fs.writeFileSync(file, buffer);
  return probeWav(file);
}
