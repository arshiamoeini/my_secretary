// The Persian lines a school-office call actually says.
//
// Deliberately covers the hard cases for a Persian voice engine:
//   - Eghrab/hamza-heavy words and ZWNJ (می‌شود، نمی‌تواند)
//   - digits spoken as dates/times/phone numbers (Persian vs Arabic digits)
//   - proper names (Iranian cities and family names)
//   - polite register (ta'arof) which an English-tuned voice flattens
//   - the mandatory AI disclosure the bridge must speak on every call

export const PHRASES = [
  {
    id: "greeting",
    kind: "opening",
    text: "سلام، وقت بخیر. شما با دفتر مدرسه شهید بهشتی صحبت می‌کنید. من دستیار صوتی هستم و هوش مصنوعی‌ام.",
  },
  {
    id: "ask-name",
    kind: "question",
    text: "لطفاً نام و نام خانوادگی خودتان را کامل بفرمایید تا در لیست تماس پیدا کنم.",
  },
  {
    id: "date-time",
    kind: "digits",
    text: "جلسه اولیا روز چهاردهم آبان ماه، ساعت نه و بیست دقیقه صبح، در سالن جلسات برگزار می‌شود.",
  },
  {
    id: "phone-number",
    kind: "digits",
    text: "شماره تماس دفتر ما صفر نه سه هفت هفت، صفر صفر صفر، صفر صفر صفر است. لطفاً یادداشت کنید.",
  },
  {
    id: "early-release",
    kind: "task",
    text: "آیا اجازه می‌دهید فرزندتان مریم احمدی امروز ساعت دوازده از مدرسه خارج شود؟ ولی او باید تنها برود.",
  },
  {
    id: "clarify",
    kind: "question",
    text: "متأسفانه صدای شما را واضح نشنیدم. ممکن است شماره پرونده را دوباره، آرام‌تر، تکرار کنید؟",
  },
  {
    id: "names",
    kind: "names",
    text: "نام دانش‌آموز سارا کلهر است و کلاس هفتم دو؛ آموزگار او آقایرضا مهدوی از مشهد است.",
  },
  {
    id: "closing",
    kind: "closing",
    text: "خیلی ممنون از همکاری شما. اطلاعات را در پرونده ثبت کردم و نتیجه را برایتان پیامک می‌کنم. روز خوش.",
  },
];

/** Caller-side lines: what the other end says, used by the round-trip test. */
export const CALLER_LINES = [
  { id: "caller-1", text: "بله، من پدر علی رضایی هستم؛ می‌خواستم بدانم فردا امتحان دارد یا نه." },
  { id: "caller-2", text: "شماره تماس من ۰۹۱۲۳۴۵۶۷۸۹ است، لطفاً برای تأیید با همین شماره تماس بگیرید." },
  { id: "caller-3", text: "نه، من اجازه نمی‌دهم دخترم تنها برود؛ لطفاً با همسرش تماس بگیرید." },
];
