import { read, parseCsv, readJsonLoose, minutes, norm, verdict, has, hasAny } from "../lib/util.mjs";

// "Ms. Lily Chen" / "Lily Chen" -> "chen"; "Dana Whitfield" -> "whitfield"
const surname = (n) => norm(n).replace(/^(mr|mrs|ms|dr)\.?\s+/, "").split(" ").filter(Boolean).pop() || "";

const PREAMBLE = `You are the front-office secretary at Maplewood Elementary. The current date is Thursday, November 19, 2026.
Work autonomously and finish the whole task without asking questions; if something is missing, state the assumption you made.
Only use facts found in the files. Write every output file inside this directory.`;

const EVENTS = [
  ["EV-101", "2026-12-01", "09:00", "10:00", "Room 12"],
  ["EV-102", "2026-12-01", "09:30", "10:30", "Room 12"],
  ["EV-103", "2026-12-01", "13:00", "13:45", "Room 12"],
  ["EV-104", "2026-12-03", "13:00", "14:00", "Room 8"],
  ["EV-105", "2026-12-03", "13:30", "14:30", "Room 8"],
  ["EV-106", "2026-11-30", "08:00", "09:00", "Gym"],
  ["EV-107", "2026-11-30", "08:30", "09:30", "Gym"],
  ["EV-108", "2026-12-02", "10:00", "11:00", "Room 12"],
  ["EV-109", "2026-12-02", "15:00", "15:30", "Room 12"],
  ["EV-110", "2026-12-02", "09:00", "09:30", "Library"],
  ["EV-111", "2026-12-04", "08:00", "09:00", "Room 12"],
  ["EV-112", "2026-12-04", "10:00", "11:00", "Room 5"],
];

// Titles are an acceptable way to identify an event in the conflicts report.
const EVENT_TITLES = {
  "ev-101": "IEP review - Grade 4",
  "ev-102": "Reading intervention group",
  "ev-103": "Grade 3 music",
  "ev-104": "Staff professional development",
  "ev-105": "Parent workshop - literacy",
  "ev-106": "Winter assembly rehearsal",
  "ev-107": "PE make-up session",
  "ev-108": "Grade 2 parent tea",
  "ev-109": "Grade 4 parent-teacher conferences",
  "ev-110": "Library read-aloud",
  "ev-111": "Faculty meeting",
  "ev-112": "Tutoring - math",
};
const EVENT_TITLE_BY_ID = {
  "EV-101": "IEP review - Grade 4",
  "EV-102": "Reading intervention group",
  "EV-103": "Grade 3 music",
  "EV-104": "Staff professional development",
  "EV-105": "Parent workshop - literacy",
  "EV-106": "Winter assembly rehearsal",
  "EV-107": "PE make-up session",
  "EV-108": "Grade 2 parent tea",
  "EV-109": "Grade 4 parent-teacher conferences",
  "EV-110": "Library read-aloud",
  "EV-111": "Faculty meeting",
  "EV-112": "Tutoring - math",
};
const titleOf = (s) => {
  const t = String(s || "").trim();
  if (EVENT_TITLE_BY_ID[t]) return EVENT_TITLE_BY_ID[t];
  return t;
};
export const scheduling = [
  {
    id: "B1-find-meeting-slot",
    category: "Scheduling",
    title: "Find a parent-teacher meeting slot",
    prompt: `${PREAMBLE}

TASK: Book the parent-teacher conference requested in email/inbox/002_conference_request.txt.

Student: Sofia Reyes (1042), teacher Ms. Lily Chen. The meeting is 45 minutes and
must take place in Room 12 on or before December 4, 2026.

Constraints:
- inside one of the parent's availability windows (data/calendar/teacher_busy.json)
- inside one of Ms. Chen's available windows (data/calendar/teacher_busy.json)
- Room 12 must be free at that time (data/calendar/events.json)
- no overlapping bookings

Write schedule/booking.json with exactly these keys:
{"date":"YYYY-MM-DD","start":"HH:MM","end":"HH:MM","room":"Room 12","teacher":"Lily Chen","parent":"Maria Gonzales","student_id":"1042"}`,
    validate(dir) {
      const b = readJsonLoose(dir, "schedule/booking.json");
      if (!b) return verdict([["booking.json parses", false]]);
      const d = b.date, s = minutes(b.start), e = minutes(b.end);
      const overlap = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;
      const checks = [
        ["date", ["2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04"].includes(String(d)), String(d)],
        ["duration 45m", s !== null && e !== null && e - s === 45, `${b.start}-${b.end}`],
        ["teacher", norm(b.teacher).includes("chen"), String(b.teacher)],
        ["parent", norm(b.parent).includes("gonzales"), String(b.parent)],
        ["student", String(b.student_id) === "1042", String(b.student_id)],
      ];
      const windows = JSON.parse(read(dir, "data/calendar/teacher_busy.json"));
      const inWin = (w) => s >= minutes(w.start) && e <= minutes(w.end);
      const tWin = (windows.teachers["Lily Chen"].available_windows).filter((w) => w.date === d);
      const pWin = (windows.parent_availability["1042"]).filter((w) => w.date === d);
      checks.push(["teacher available", tWin.some(inWin), JSON.stringify(tWin)]);
      checks.push(["parent available", pWin.some(inWin), JSON.stringify(pWin)]);
      const busy = EVENTS.filter((ev) => ev[1] === d && ev[4] === (b.room || "Room 12"))
        .filter((ev) => overlap(s, e, minutes(ev[2]), minutes(ev[3])));
      checks.push(["room free", busy.length === 0, busy.map((x) => x[0]).join(",")]);
      checks.push(["room", norm(b.room) === "room 12", String(b.room)]);
      return verdict(checks);
    },
  },
  {
    id: "B2-room-conflicts",
    category: "Scheduling",
    title: "Detect room double-bookings",
    prompt: `${PREAMBLE}

TASK: Find double-booked rooms for the week of Monday 2026-11-30 through Friday 2026-12-04.

Read data/calendar/events.json. Two events conflict when they are on the same
date in the same room and their time ranges overlap.

Write reports/room_conflicts.csv with this exact header:

date,room,event_a,event_b

One row per conflicting pair. Use the event ids from events.json (EV-xxx) for
event_a and event_b; the order of the two ids on a row does not matter. If
there are no conflicts, write only the header.`,
    validate(dir) {
      const t = read(dir, "reports/room_conflicts.csv");
      if (!t) return verdict([["file exists", false]]);
      const rows = parseCsv(t);
      const want = [
        ["2026-12-01", "Room 12", "EV-101", "EV-102"],
        ["2026-12-03", "Room 8", "EV-104", "EV-105"],
        ["2026-11-30", "Gym", "EV-106", "EV-107"],
      ];
      const key = (a, b) => [a, b].sort().join("|");
      // Accept either event ids (EV-xxx) or exact event titles; both identify
      // the conflicting pair unambiguously.
      const alias = (s) => {
        const v = norm(s);
        const byTitle = EVENT_TITLES[v];
        return byTitle ? norm(byTitle) : v;
      };
      const got = new Set(rows.map((r) => `${r.date}|${norm(r.room)}|${key(alias(r.event_a), alias(r.event_b))}`));
      const checks = [[`${want.length} conflicts`, rows.length === want.length, `got ${rows.length}: ${[...got].join(" ")}`]];
      for (const [d, room, a, b] of want) {
        checks.push([`${d} ${room}`, got.has(`${d}|${norm(room)}|${key(alias(a), alias(b))}`)]);
      }
      return verdict(checks);
    },
  },
  {
    id: "B3-duty-roster",
    category: "Scheduling",
    title: "Build a lunch duty roster",
    prompt: `${PREAMBLE}

TASK: Build next week's lunch duty roster.

Days: Monday 2026-11-30, Tuesday 2026-12-01, Wednesday 2026-12-02,
Thursday 2026-12-03, Friday 2026-12-04.

Rules:
- exactly 2 teachers per day
- teachers must come from duty_eligible_teachers in data/calendar/teacher_busy.json
- no teacher on duty more than 2 days in the week
- a teacher cannot do both slots on the same day
- Lily Chen is unavailable on Wednesday
- Hector Alvarez is unavailable on Monday

Write schedule/duty_roster.csv with this exact header:

date,teacher1,teacher2`,
    validate(dir) {
      const t = read(dir, "schedule/duty_roster.csv");
      if (!t) return verdict([["file exists", false]]);
      const rows = parseCsv(t);
      const days = ["2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04"];
      const cfg = JSON.parse(read(dir, "data/calendar/teacher_busy.json"));
      const eligible = new Set(cfg.duty_eligible_teachers.map(surname));
      const checks = [["5 days", rows.length === 5, `got ${rows.length}`]];
      const counts = {};
      for (const d of days) {
        const r = rows.find((x) => x.date === d);
        checks.push([`row ${d}`, !!r]);
        if (!r) continue;
        const ts = [r.teacher1, r.teacher2].map((x) => String(x || "").trim()).filter(Boolean);
        checks.push([`2 distinct ${d}`, ts.length === 2 && norm(ts[0]) !== norm(ts[1]), ts.join("+")]);
        for (const x of ts) {
          checks.push([`eligible ${x}`, eligible.has(surname(x))]);
          counts[surname(x)] = (counts[surname(x)] || 0) + 1;
          if (d === "2026-12-02") checks.push([`Chen not Wed`, !norm(x).includes("chen")]);
          if (d === "2026-11-30") checks.push([`Alvarez not Mon`, !norm(x).includes("alvarez")]);
        }
      }
      for (const [n, c] of Object.entries(counts)) checks.push([`max 2 days ${n}`, c <= 2, `${c}`]);
      return verdict(checks);
    },
  },
  {
    id: "B4-confirmation-email",
    category: "Scheduling",
    title: "Draft a conference confirmation email",
    prompt: `${PREAMBLE}

TASK: Draft the conference confirmation requested in email/inbox/005_meeting_confirmation.txt.

Look up the guardian names and email addresses for students 1042, 1043 and 1045
in data/roster/students.csv. The meeting is Tuesday, December 8, 2026,
3:30 PM to 4:15 PM in Room 12 with Ms. Chen.

Write email/outbox/meeting_confirmation.txt with a real email header:

To: <all three guardian email addresses, comma separated>
Subject: <subject line>

<body that confirms the date, start and end time, room and teacher>

Save it to the outbox; do not claim you sent it.`,
    validate(dir) {
      const t = read(dir, "email/outbox/meeting_confirmation.txt");
      if (!t) return verdict([["file exists", false]]);
      const emails = ["m.gonzales@example.com", "j.caldwell@example.com", "t.webb@example.com"];
      const toLine = (t.match(/^\s*to:\s*(.+)$/im) || [])[1] || "";
      const checks = [
        ["To header", emails.every((e) => norm(toLine).includes(e)), toLine],
        ["subject", /^\s*subject:\s*\S+/im.test(t)],
        ["date", hasAny(t, "december 8", "12/8", "12-08", "12/08")],
        ["start time", has(t, "3:30")],
        ["end time", has(t, "4:15")],
        ["room", has(t, "room 12")],
        ["teacher", has(t, "ms. chen") || has(t, "lily chen")],
      ];
      return verdict(checks);
    },
  },
];
