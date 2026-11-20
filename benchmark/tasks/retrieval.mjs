import { read, parseCsv, norm, verdict, has, money, labeled, list } from "../lib/util.mjs";

const PREAMBLE = `You are the front-office secretary at Maplewood Elementary. The current date is Thursday, November 19, 2026.
Work autonomously and finish the whole task without asking questions; if something is missing, state the assumption you made.
Only use facts found in the files. Write every output file inside this directory.`;

export const retrieval = [
  {
    id: "C1-allergy-list",
    category: "Retrieval",
    title: "Grade 5 allergy list",
    prompt: `${PREAMBLE}

TASK: Make an allergy reference sheet for the Grade 5 lunch monitors.

Look in data/health/health_records.csv and data/roster/students.csv.

Write reports/allergy_grade5.md with one line per Grade 5 student who has a
listed allergy, in this exact format:

- <First Last>: <allergen>

List only students who actually have a listed allergy.`,
    validate(dir) {
      const t = read(dir, "reports/allergy_grade5.md");
      if (!t) return verdict([["file exists", false]]);
      const want = { "olivia chen": "peanuts", "ryan kowalski": "shellfish", "grace adeyemi": "tree nuts" };
      const grade5 = parseCsv(read(dir, "data/roster/students.csv"))
        .filter((s) => s.grade === "5")
        .map((s) => norm(`${s.first_name} ${s.last_name}`));
      const got = new Map();
      for (const l of t.split("\n").map((x) => x.trim()).filter((x) => x.startsWith("-"))) {
        const m = l.replace(/^-\s*/, "").match(/^([^:]+):\s*(.+)$/);
        if (!m) continue;
        // only count bullets that name a real Grade 5 student
        const hit = grade5.find((n) => norm(m[1]) === n);
        if (hit) got.set(hit, norm(m[2]));
      }
      const checks = [["exactly 3 students listed", got.size === 3, `got ${got.size}: ${[...got.keys()].join(", ")}`]];
      for (const [name, allergen] of Object.entries(want)) {
        checks.push([name, (got.get(name) || "").includes(allergen), got.get(name) || "missing"]);
      }
      return verdict(checks);
    },
  },
  {
    id: "C2-medication-policy",
    category: "Retrieval",
    title: "Medication policy summary",
    prompt: `${PREAMBLE}

TASK: A new office aide starts Monday and needs a short summary of the
medication policy.

Read policies/handbook.md.

Write reports/medication_policy.md, at most 150 words, that covers who may
administer medication, what paperwork is required, what must be recorded, and
the self-carry exception. End with a line "Source: <section>" naming the
handbook section.`,
    validate(dir) {
      const t = read(dir, "reports/medication_policy.md");
      if (!t) return verdict([["file exists", false]]);
      const n = norm(t);
      return verdict([
        ["nurse", n.includes("nurse")],
        ["parent authorization", n.includes("parent") && (n.includes("written") || n.includes("signed"))],
        ["physician order", n.includes("physician")],
        ["log records", n.includes("log")],
        ["self-carry exception", n.includes("inhaler") && n.includes("epinephrine")],
        ["source section", /source:.*\b(section\s*)?2\.2\b/i.test(t)],
        ["length", t.split(/\s+/).length <= 160, `${t.split(/\s+/).length} words`],
      ]);
    },
  },
  {
    id: "C3-bus-route",
    category: "Retrieval",
    title: "Who monitors the Oak Street bus",
    prompt: `${PREAMBLE}

TASK: A parent on Oak Street wants to know who rides their bus and when it leaves.

Read policies/bus_routes.md and answer: which staff member monitors the route
that serves Oak Street, and what time does that bus depart?

Write reports/bus_oak.md with two lines:

Route: <route number>
Monitor: <staff name>
Departure: <time>

Then one sentence answering the parent.`,
    validate(dir) {
      const t = read(dir, "reports/bus_oak.md");
      if (!t) return verdict([["file exists", false]]);
      const n = norm(t);
      return verdict([
        ["route 4", /route 4\b/.test(n) || n.includes("route: 4")],
        ["monitor Delgado", n.includes("delgado")],
        ["departure 7:42", n.includes("7:42")],
      ]);
    },
  },
  {
    id: "C4-overdue-library",
    category: "Retrieval",
    title: "Overdue library books, Grade 4",
    prompt: `${PREAMBLE}

TASK: Prepare the Grade 4 overdue library notice for 2026-11-18.

A loan is overdue when due_date is before 2026-11-18 and returned_date is empty.
The fine is 25 cents per day overdue, counted from the due date up to and
including 2026-11-18 (days late = 2026-11-18 minus due_date, in days).

Use data/library/loans.csv and data/roster/students.csv.

Write reports/overdue_grade4.csv with this header:

student_id,student_name,title,days_late,fine_usd

One row per overdue Grade 4 loan, sorted by student_id. Then write the grand
total as reports/overdue_grade4_total.txt containing only the amount, e.g. $0.00`,
    validate(dir) {
      const t = read(dir, "reports/overdue_grade4.csv");
      const tot = read(dir, "reports/overdue_grade4_total.txt");
      if (!t) return verdict([["csv exists", false]]);
      const rows = parseCsv(t);
      const want = [
        ["1041", "Wonder", "14", "3.50"],
        ["1043", "Holes", "6", "1.50"],
        ["1044", "Holes", "7", "1.75"],
        ["1046", "The One and Only Ivan", "21", "5.25"],
      ];
      const checks = [["4 rows", rows.length === 4, `got ${rows.length}`]];
      for (const [id, title, days, fine] of want) {
        const r = rows.find((x) => String(x.student_id) === id);
        checks.push([
          `row ${id}`,
          !!r && norm(r.title) === norm(title) && Number(r.days_late) === Number(days) && Math.abs(money(r.fine_usd) - Number(fine)) < 0.001,
          r ? `${r.title}/${r.days_late}/${r.fine_usd}` : "missing",
        ]);
      }
      checks.push(["total", tot !== null && Math.abs(money(tot) - 12.0) < 0.001, String(tot).trim()]);
      return verdict(checks);
    },
  },
];
