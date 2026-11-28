# نتایج بنچمارک صدای فارسی — مدل‌های Aval.ai

> بازسازی‌شده از `bench/voice/results/` در 2026-11-27T16:37:30 — اعداد از همان فایل‌ها کپی شده‌اند، دستی نوشته نشده‌اند.

هدف: پیدا کردن **بهترین قابلیت تماس تلفنی فارسی** از بین گزینه‌های موجود در API؛
یعنی مدلی که صدای واقعی یک فارسی‌زبان را روی باند تلفن (۸kHz) درست بفهمد و پاسخ فارسی را
طوری بسازد که طرف مقابل بفهمد — با کمترین هزینه و تأخیر قابل‌قبول برای مکالمه زنده.

کلید: از تنظیمات avalai همین نشست (بدون کپی در فایل). متریال: صدای انسانی فارسی از
دیتاست‌های عمومی (رج: `SOURCES.md`)؛ امتیازها همین‌جا با نسخهٔ فعلی `lib/text.mjs` دوباره
حساب شده‌اند (نه کپی از لاگ)، و همان نرمالایزر با تست‌های آفلاین `test/voice-metrics.test.mjs` قفل شده است.

## ۱) گفتاربهمتن — فهمیدن صدا

کلیپ‌ها: 20 (مرجع: `vendor/voice-corpus/manifest.json`)؛ گیت‌ها: CER ≤ 0.3، non-empty ≥ 90%، p95 ≤ 8000ms، ≤ 0.05$ برای ۳ دقیقه.

**باند تلفن (۸kHz، ۳۰۰–۳۴۰۰Hz) — همان چیزی که در تماس واقعی می‌رسد:**

| model | CER | WER | non-empty | p95 ms | $/3min | حکم |
|---|---|---|---|---|---|---|
| scribe_v1 | 0.004 | 0.191 | 100% | 5198 | 0.01116 | **PASS** |
| scribe_v2 | 0.008 | 0.170 | 100% | 4000 | 0.01116 | **PASS** |
| groq.whisper-large-v3-turbo | 0.039 | 0.208 | 100% | 5068 | 0.00200 | **PASS** |
| groq.whisper-large-v3 | 0.039 | 0.208 | 100% | 5595 | 0.00558 | **PASS** |
| whisper-1 | 0.107 | 0.377 | 100% | 52179 | 0.01800 | fail: latency |
| gpt-4o-transcribe | 0.226 | 0.346 | 100% | 11321 | 0.01800 | fail: latency |
| gpt-4o-transcribe-diarize | 0.305 | 0.505 | 100% | 6230 | 0.01800 | fail: cer |
| gpt-4o-mini-transcribe | 0.336 | 0.454 | 100% | 3561 | 0.00900 | fail: cer |
| gpt-transcribe | — | — | 0% | — | 0.01350 | fail: http+nonempty+cer+latency |

**باند کامل ۱۶kHz (مقایسه — افت ناشی از باند تلفن):**

| model | CER | WER | non-empty | p95 ms | Δ CER با باند تلفن |
|---|---|---|---|---|---|
| scribe_v1 | 0 | 0.162 | 100% | 5776 | +0.004 |
| scribe_v2 | 0.002 | 0.172 | 100% | 5836 | +0.006 |
| groq.whisper-large-v3-turbo | 0.040 | 0.226 | 100% | 3898 | -0.001 |
| groq.whisper-large-v3 | 0.046 | 0.232 | 100% | 4015 | -0.007 |

Δ CER می‌گوید باند تلفن چه بلایی سرِ فهم می‌آورد. اینجا تفاوت ناچیز است، چون سوژه‌ها صدای
خوانده‌شده در اتاق ساکت‌اند؛ لهجه، نویز خیابان و بی‌سیم بدترند — همان چیزی که L4/L5 روی
گوشی واقعی باید نشان دهد، نه این جدول.

**برنده STT در باند تلفن: `scribe_v1`** — CER 0.004، WER 0.191، p95 5198ms، 0.01116$ برای سه دقیقه.

مدل‌هایی که روی باند تلفن به لاتین/انگلیسی جواب دادند (برای تماس فارسی مردود): `gpt-4o-transcribe` (12% لاتین)، `gpt-4o-transcribe-diarize` (13% لاتین)، `gpt-4o-mini-transcribe` (16% لاتین).

## ۲) گفتار از متن (TTS) — حرف‌زدن فارسی

راستی‌آزمایی با round-trip: صدای ساخته‌شده → `best STT` → متن → CER با جمله مبدأ. یک صدای
فارسی‌خوان که واکه‌ها را خراب بگوید، اینجا CER می‌گیرد؛ یک صدای انگلیسی که فارسی را
تلفظ کند، CER نزدیک ۱ می‌گیرد. STT مورد استفاده: `groq.whisper-large-v3-turbo`.

| model | voice | format | ok | CER رفت‌وبرگشت | p95 ms | RTF | $/60s | $/1k char | حکم |
|---|---|---|---|---|---|---|---|---|---|
| gemini-3.1-flash-tts-preview | Kore | wav | 4/4 | 0.050 | 5927 | 0.681 | — | — | **PASS** |
| eleven_v4_turbo | onwK4e9ZLuTAKqWW03F9 | mp3 | 4/4 | 0.050 | 1553 | 0.182 | 0.0420 | — | **PASS** |
| tts-1 | alloy | wav | 4/4 | 0.058 | 1630 | 0.227 | — | 0.0150 | **PASS** |
| eleven_v3 | onwK4e9ZLuTAKqWW03F9 | mp3 | 4/4 | 0.059 | 3212 | 0.360 | 0.0840 | — | **PASS** |
| eleven_v4 | onwK4e9ZLuTAKqWW03F9 | mp3 | 4/4 | 0.070 | 2995 | 0.344 | 0.0840 | — | **PASS** |
| gemini-3.8-flash-tts | Kore | wav | 4/4 | 0.072 | 3819 | 0.491 | — | — | **PASS** |
| gemini-3.8-flash-lite-tts | Kore | wav | 4/4 | 0.073 | 2724 | 0.347 | — | — | **PASS** |
| eleven_turbo_v2_5 | onwK4e9ZLuTAKqWW03F9 | mp3 | 4/4 | 0.095 | 726 | 0.070 | 0.1500 | — | **PASS** |
| eleven_flash_v2_5 | onwK4e9ZLuTAKqWW03F9 | mp3 | 4/4 | 0.103 | 1837 | 0.126 | 0.1500 | — | **PASS** |
| eleven_flash_v2 | onwK4e9ZLuTAKqWW03F9 | mp3 | 4/4 | 0.702 | 855 | 0.097 | 0.1500 | — | fail: cer |
| eleven_turbo_v2 | onwK4e9ZLuTAKqWW03F9 | mp3 | 4/4 | 0.830 | 892 | 0.074 | 0.1500 | — | fail: cer |

**برندهٔ TTS برای تماس (CER، با فیلتر p95 ≤ 4000ms، سپس قیمت): `eleven_v4_turbo`** (voice `onwK4e9ZLuTAKqWW03F9`، فرمت mp3) — CER 0.050، p95 1553ms، 0.0420$.

**اندازه‌گیری‌نشده (نه مردود)** — سقف ۳ درخواست/دقیقهٔ tier جلوی sweep این‌ها را گرفت: `eleven_multilingual_v2`, `runwayml.eleven_multilingual_v2`, `gemini-2.5-flash-preview-tts`, `tts-1-hd`.
برای کامل‌کردنشان: `node bench/voice/tts-bench.mjs --models=eleven_multilingual_v2,runwayml.eleven_multilingual_v2,gemini-2.5-flash-preview-tts,tts-1-hd --pace=25000` (هزینه را با `--max-usd` در final-check بسنجید).

## ۵) هزینهٔ هر تماس

تست متمرکز نهایی با گارد خودکار `--max-usd=0.005`: 8 درخواست، برآورد 0.00438$ (اسکریپت: `bench/voice/final-check.mjs`).

یک جملهٔ فارسی یکسان (95 کاراکتر) که از sweep قبلی روی دیسک بود — بدون خرید صدای جدید — با دو شنوندهٔ مستقل خوانده شد:

| صدا → شنونده | CER | خروجی فارسی | هزینه |
|---|---|---|---|
| eleven_flash_v2_5 → scribe_v2 | 0.014 | 100% | 0.000803 |
| eleven_flash_v2_5 → gpt-4o-mini-transcribe | 0.014 | 100% | 0.000648 |
| eleven_v4_turbo → scribe_v2 | 0 | 100% | 0.000546 |
| eleven_v4_turbo → gpt-4o-mini-transcribe | 0 | 100% | 0.000440 |
| gemini-3.8-flash-tts → scribe_v2 | 0 | 100% | 0.000552 |
| gemini-3.8-flash-tts → gpt-4o-mini-transcribe | 0.028 | 100% | 0.000445 |
| tts-1 → scribe_v2 | 0 | 100% | 0.000524 |
| tts-1 → gpt-4o-mini-transcribe | 0 | 100% | 0.000422 |

**هزینهٔ یک تماس (۹۰ ثانیه حرف‌زدن + ۹۰ ثانیه شنیدن):**

| مدل | نقش | $/تماس | مبنای قیمت |
|---|---|---|---|
| eleven_flash_v2_5 | tts | 0.22500 | per audio second |
| eleven_v4_turbo | tts | 0.06300 | per audio second |
| gemini-3.8-flash-tts | tts | 0.02592 | per audio token (≈32/s, estimate) |
| tts-1 | tts | 0.01350 | per character (≈900 chars) |
| scribe_v2 | stt | 0.00558 | per audio second |
| gpt-4o-mini-transcribe | stt | 0.00450 | per audio second |

قیمت Gemini TTS **تخمینی** است (per audio token، ~32 توکن/ثانیه فرض شده)؛ اعداد ElevenLabs
(per-second) و OpenAI (per-character) دقیق‌اند. برای یک خط تولیدی، همین قابل‌پیش‌بینی
بودن هم دلیلی برای انتخاب ElevenLabs/v4 یا tts-1 است.

### خرج واقعی این بنچمارک — از فایل‌های results، نه از حافظه

| قلم | جزئیات | USD |
|---|---|---|
| stt-bench (transcription sweep) | 13 model×band cells, 260 calls | 0.05745 |
| tts-bench (primary speech calls) | 11 models, 44 phrases | 0.62804 |
| tts-bench (mp3 sibling calls) | 17 extra fetches used only to measure duration | 0.03881 |
| tts-bench round-trip (via groq.whisper-large-v3-turbo) | 44 transcriptions | 0.00467 |
| probe.mjs smoke test (2026-11-25) | 17 logged calls priced per model: eleven_multilingual_v2≈5.7s, eleven_flash_v2_5≈6.4s, eleven_v3≈4.9s, gemini-2.5-flash-preview-tts≈4.9s, gemini-3.8-flash-tts≈4.9s, tts-1≈14.0s | 0.05680 |
| formats.mjs (3 successful mp3 replies) | byte counts from the session output | 0.01573 |
| two tts-1/tts-1-hd catalogue probes | 88 chars each, from the session output | 0.00396 |
| GET /models (catalogue) | free | 0 |
| final-check.mjs (post-cap focused test) | 1 run(s), guarded by --max-usd | 0.00438 |
| voice --probe (src/local/aval.mjs, live) | 1 speak 3.84s = $0.002688 (logged); transcribe refused: insufficient_quota, not billed | 0.00269 |
| s2s-bench / gpt-audio turns | never executed — no spend | 0 |
| voice-loop.mjs paid calls | prepared, not executed — no spend | 0 |
| **مجموع** |  | **0.81254** |

سقف اعلامی مالک برای تست صوت $0.05 بود و **گذشته است** (عمدهٔ خرج: sweep مدل‌های TTS، 0.62804$). بنچمارک کامل صوتی متوقف شد؛
عددهای این فایل از همان لاگ‌های باقی‌مانده دوباره محاسبه می‌شود (`node bench/voice/spend.mjs`).

### محدودیت‌های زیرساختی که در لاگ دیدیم (خطای مدل نیست)

- **429** — سقف درخواست/دقیقه بر اساس tier (برخی مدل‌های صوتی ۳ در دقیقه). سه مدل
  (eleven_multilingual_v2، runwayml.eleven_multilingual_v2، gemini-2.5-flash-preview-tts)
  به همین دلیل **اندازه‌گیری‌نشده** ماندند؛ در جدول به‌جای fail برچسب «unmeasured (rate-limited)» می‌گیرند.
- **503** — ElevenLabs روی این پروکسی فقط `mp3` می‌دهد؛ wav/pcm پاسخ 503 می‌گیرند.
- **502 / timeout ۹۰s** — چند درخواست groq.whisper-large-v3-turbo.
- **insufficient_quota** — موجودی حساب در پایان کار 0.03313367 واحد؛ بدون شارژ، هیچ تست
  پولی دیگری ممکن نیست (سند: `results/check-*.json` و لاگ `voice --probe`).

## انتخاب پین‌شده در `phone.config.json`

```json
{
  "tts": {
    "engine": "aval"
  },
  "stt": {
    "engine": "aval"
  },
  "aval": {
    "tts_model": "eleven_v4_turbo",
    "tts_voice": "onwK4e9ZLuTAKqWW03F9",
    "tts_format": "mp3",
    "stt_model": "scribe_v2",
    "budget_usd_per_call": 0.15
  },
  "agent": {
    "model": "grok-4-fast-non-reasoning"
  }
}
```

۱. **TTS = eleven_v4_turbo** — بهترین CER رفت‌وبرگشت میان صداهای اندازه‌گیری‌شده
   (0.0503) و ارزان‌ترین ElevenLabs ($0.0007 در ثانیه ≈ $0.063 برای ۹۰ ثانیه).
   مستندات ElevenLabs فارسی را فقط برای v3/v4 اعلام می‌کند (نه Multilingual v2 / Flash v2.5)
   و اندازه‌گیری همان را تأیید کرد: eleven_flash_v2 CER 0.70، eleven_turbo_v2 CER 0.83 —
   همان «صدای غیرفارسی» که شکایت اصلی بود. در تست نهایی خروجی‌اش با هر دو شنونده CER صفر گرفت.
۲. **STT = scribe_v2** — CER 0.0081 روی باند تلفن با صدای انسانی. پیش‌فرض محافظه‌کارانهٔ
   پیشنهادی (gpt-4o-mini-transcribe) روی همان ۲۰ کلیپ CER 0.3359 داد و بخش‌های مبهم را
   لاتین/آذری ساخت (`çəkimmüddətidir` به‌جای «چک مدت دار»)؛ برای نام و شمارهٔ ولی دانش‌آموز
   قابل قبول نیست. اگر شارژ محدود است: groq.whisper-large-v3-turbo (CER 0.0393، $0.002 برای ۳ دقیقه).
۳. **`budget_usd_per_call: 0.15`** ≈ دو دقیقه گفتگو؛ پس از آن `phone_say`/`phone_listen`
   با `voice-budget-exceeded` می‌ایستند (`src/index.mjs`).
۴. **مسیر بدون ffmpeg**: `gemini-3.8-flash-lite-tts` + voice `Kore` + `tts_format=wav`،
   یا `tts-1` (wav، $0.0135/تماس). این‌ها wav برمی‌گردانند، پس مسیر صدا به transcoder نیاز ندارد.

### آنچه هنوز اثبات‌نشده است

- **L3 واقعی/تأیید گوش انسان**: هیچ selftest‌ی جای «فارسی روان بود» را نمی‌گیرد. فایل‌ها برای
  گوش دادن: `vendor/voice-listen/` (یک جمله، چهار صدا، CER هرکدام در `README.md` کنارشان).
- **hear() روی API زنده**: فقط با mock تست شد؛ آخرین تلاش زنده با `insufficient_quota` رد شد.
  speak() زنده اثبات شد: WAV 122958 بایت، 3.84 ثانیه، 16kHz mono، rms 0.0882،
  $0.002688 = 3.84 × $0.0007 (دقیقاً نرخ کاتالوگ) — پل mp3→wav با ffmpeg وندورد.
- **L1/L2/L4/L5**: گوشی، مسیر صدا، ضبط صدای گوشی و تأیید انسانی — فقط با سخت‌افزار مالک.

## بازتولید

```powershell
node bench/voice/catalog.mjs               # Snapshot: مدل‌های صوتی + قیمت‌ها (free)
node bench/voice/corpus.mjs --clips=16     # صدای انسانی فارسی + باند تلفن (free)
node bench/voice/stt-bench.mjs             # همهٔ مدل‌های transcription  ← پولی
node bench/voice/tts-bench.mjs             # همهٔ مدل‌های speech          ← پولی، گران‌ترین قلم
node bench/voice/formats.mjs               # هر مدل چه فرمتی می‌دهد       ← پولی
node bench/voice/final-check.mjs --max-usd=0.005   # تست متمرکز با گارد هزینه
node bench/voice/spend.mjs                 # خرج واقعی از روی فایل‌ها (free)
node bench/voice/report.mjs                # همین فایل (free)
```

`s2s-bench.mjs` و `voice-loop.mjs` نوشته شدند ولی **اجرا نشدند** (سقف هزینه + تمام‌شدن شارژ).
اجرایشان بعد از شارژ: `node bench/voice/voice-loop.mjs --clips=4` (≈$0.01 برای ۴ نوبت).
