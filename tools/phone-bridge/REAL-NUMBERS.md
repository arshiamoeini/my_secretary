# Real test numbers for the call path

Finding: a *real* call needs a real destination. These are Iranian numbers that
are published by the organisations themselves, answer automatically (IVR), and
therefore let the phone path be verified on a live carrier without asking a
person to hold a handset. The bridge still refuses everything until the human
operator approves (`PHONE_ALLOW_DIAL=1`) and the number is in the allowlist.

Verified 2026-11-23 from the operators' own "تماس با ما" pages:

| Number (national) | Owner | Source | Works with this bridge? |
| --- | --- | --- | --- |
| `09377000000` | Irancell support — "از سایر خطوط" | irancell.ir/p/1590/contact-us | **yes** — 11-digit mobile form |
| `09129990` | MCI (همراه اول) call centre — landline/other-lines form | mci.ir/contact ("Via the landline: +989129990") | **no** — 8 digits; `normalizeIranNumber` rejects it (`invalid-number`). It is a carrier short code, not a national number. |
| `9990` | MCI call centre — from an MCI SIM | mci.ir/contact | **no** — short code, same reason |
| `700` | Irancell support — from an Irancell SIM | irancell.ir/p/1590/contact-us | **no** — short code |
| `200` | Rightel support | rightel.ir/p/943/contact-us | **no** — short code |
| `118` | Telephone directory assistance (TTC) | fa.wikipedia.org — راهنمای تلفن ۱۱۸ | **no** — short code |

Consequences, stated plainly:

1. The **first real test target is `09377000000`** (Irancell support IVR, full
   national form). A call to it rings the real carrier, is answered by a real
   automated voice, and produces genuine 8–16 kHz phone audio on the PC capture
   side — no human counterpart needed. Carrier charges apply; from an Iranian
   SIM this is a normal local call.
2. **The best L5 target remains the operator's own number** (the phone's second
   SIM or a colleague's handset), because only a human can confirm "I heard
   intelligible Persian" — see `NEXT-AGENT.md` §5. Put it into the allowlist;
   it is not in this file (no real private numbers committed, per trap 15).
3. **Short codes are a real gap.** People *will* be asked to call `9990` or
   `118`. Today the bridge rejects them as `invalid-number` by design — the
   validator only knows the 11-digit national forms. Supporting them means a
   deliberate decision (they bypass the "Iranian number" contract and any
   per-number policy), so it is logged as a P3 question in `NEXT-AGENT.md`,
   not patched in silently.

How this feeds the configuration: `phone.config.json` (gitignored) carries the
operator's own number plus `09377000000` in `allowlist`, with
`max_calls: 2` for the bring-up phase. Nothing here changes what the gates do.
