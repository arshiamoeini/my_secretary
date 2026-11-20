import { read, exists, parseCsv, labeled, num, verdict, money } from "../lib/util.mjs";

const PREAMBLE = `You are the front-office secretary at Maplewood Elementary. The current date is Thursday, November 19, 2026.
Work autonomously and finish the whole task without asking questions; if something is missing, state the assumption you made.
Only use facts found in the files. Write every output file inside this directory.`;

export const admin = [
  {
    id: "A1-attendance-summary",
    category: "Administrative",
    title: "Daily attendance summary",
    prompt: `${PREAMBLE}

TASK: Produce yesterday's attendance summary for the principal.

Use data/attendance/2026-11-18.csv and data/roster/students.csv.

Write reports/attendance_summary_2026-11-18.md containing exactly these lines
(one per line, plain text, no table):

Enrolled: <number>
Absent: <number>
Unexcused: <number>

Per grade:
- Grade K: <number>
- Grade 1: <number>
- Grade 2: <number>
- Grade 3: <number>
- Grade 4: <number>
- Grade 5: <number>

"Absent" counts students whose status is absent (tardy is not absent). "Unexcused"
counts absences with excused=FALSE. Per-grade numbers are absent counts per grade.`,
    validate(dir) {
      const t = read(dir, "reports/attendance_summary_2026-11-18.md");
      if (!t) return verdict([["file exists", false]]);
      const stu = parseCsv(read(dir, "data/roster/students.csv"));
      const att = parseCsv(read(dir, "data/attendance/2026-11-18.csv"));
      const gradeOf = new Map(stu.map((s) => [s.student_id, s.grade]));
      const absent = att.filter((a) => a.status.toLowerCase() === "absent");
      const unexcused = absent.filter((a) => String(a.excused).toUpperCase() === "FALSE");
      const per = {};
      for (const g of ["K", "1", "2", "3", "4", "5"]) per[g] = 0;
      for (const a of absent) per[gradeOf.get(a.student_id)]++;
      const checks = [
        ["enrolled", num(labeled(t, ["Enrolled"])) === stu.length, `want ${stu.length}`],
        ["absent", num(labeled(t, ["Absent"])) === absent.length, `want ${absent.length}`],
        ["unexcused", num(labeled(t, ["Unexcused"])) === unexcused.length, `want ${unexcused.length}`],
      ];
      for (const g of ["K", "1", "2", "3", "4", "5"]) {
        const v = num(labeled(t, [`Grade ${g}`, `- Grade ${g}`]));
        checks.push([`grade ${g}`, v === per[g], `want ${per[g]} got ${v}`]);
      }
      return verdict(checks);
    },
  },
  {
    id: "A2-fieldtrip-permissions",
    category: "Administrative",
    title: "Field trip permission audit",
    prompt: `${PREAMBLE}

TASK: Audit permission slips for the Grade 3 trip.

Read email/inbox/003_field_trip.txt and the scanned slips in
forms/permission_slips/. Cross-reference them with data/roster/students.csv.

Write reports/fieldtrip_permissions.csv with this exact header:

student_id,student_name,signed

One row per Grade 3 student (7 students), sorted by student_id, where signed is
YES or NO. A slip only counts if it is for the Natural History Museum trip on
2026-12-04 — slips for other trips or school years do not count.`,
    validate(dir) {
      const t = read(dir, "reports/fieldtrip_permissions.csv");
      if (!t) return verdict([["file exists", false]]);
      const rows = parseCsv(t);
      const truth = {
        1031: "YES", 1032: "NO", 1033: "YES", 1034: "NO",
        1035: "YES", 1036: "YES", 1037: "NO",
      };
      const got = new Map(rows.map((r) => [r.student_id, String(r.signed || r.signed_ || "").toUpperCase()]));
      const checks = [["7 rows", rows.length === 7, `got ${rows.length}`]];
      for (const [id, want] of Object.entries(truth)) {
        checks.push([`student ${id}`, got.get(id) === want, `want ${want} got ${got.get(id)}`]);
      }
      return verdict(checks);
    },
  },
  {
    id: "A3-purchase-order",
    category: "Administrative",
    title: "Purchase order with budget check",
    prompt: `${PREAMBLE}

TASK: Prepare purchase order PO-2026-114.

Read email/inbox/004_supply_order.txt, data/budget/budget.csv and
forms/purchase_order_template.md. Charge the order to Classroom Supplies.

Write reports/PO-2026-114.md based on the template, and make sure it contains
these labeled lines (any formatting around them is fine):

Total: $<amount>
Remaining after purchase: $<amount>
Over budget: <YES or NO>

Total is the sum of all line items. Remaining after purchase is the budget
category's remaining balance minus the total (negative if it overruns).`,
    validate(dir) {
      const t = read(dir, "reports/PO-2026-114.md");
      if (!t) return verdict([["file exists", false]]);
      const total = money(labeled(t, ["Total"]));
      const rem = money(labeled(t, ["Remaining after purchase"]));
      const over = (labeled(t, ["Over budget"]) || "").toUpperCase();
      return verdict([
        ["total", total === 813.5, `want 813.50 got ${total}`],
        ["remaining after", rem === -193.5, `want -193.50 got ${rem}`],
        ["over budget flag", over.startsWith("YES"), `got ${over}`],
      ]);
    },
  },
  {
    id: "A4-file-organization",
    category: "Administrative",
    title: "Organize scanned documents",
    prompt: `${PREAMBLE}

TASK: File the unsorted scanned documents.

The scans in data/docs/messy/ were dropped by the copier. Read each one, then
move/copy it to:

archive/<grade>/<document_type>/<original filename>

grade is K, 1, 2, 3, 4 or 5. document_type is one of:
immunization_record, incident_report, enrollment_form, permission_slip, transcript_request

Then write archive/INDEX.csv with this exact header:

filename,grade,document_type,student_id

One row per document (10 documents), sorted by filename. Keep the original
filenames.`,
    validate(dir) {
      const truth = [
        ["scan_0412.txt", "4", "immunization_record", "1041"],
        ["scan_0413.txt", "3", "incident_report", "1032"],
        ["scan_0414.txt", "2", "enrollment_form", "1025"],
        ["scan_0415.txt", "5", "immunization_record", "1051"],
        ["scan_0416.txt", "5", "permission_slip", "1057"],
        ["scan_0417.txt", "4", "incident_report", "1045"],
        ["scan_0418.txt", "K", "enrollment_form", "1003"],
        ["scan_0419.txt", "5", "transcript_request", "1052"],
        ["scan_0420.txt", "2", "immunization_record", "1023"],
        ["scan_0421.txt", "1", "incident_report", "1014"],
      ];
      const checks = [];
      for (const [f, g, d] of truth) checks.push([`filed ${f}`, exists(dir, `archive/${g}/${d}/${f}`)]);
      const rows = parseCsv(read(dir, "archive/INDEX.csv"));
      checks.push(["index rows", rows.length === 10, `got ${rows.length}`]);
      const byName = new Map(rows.map((r) => [r.filename, r]));
      for (const [f, g, d, id] of truth) {
        const r = byName.get(f);
        checks.push([
          `index ${f}`,
          !!r && String(r.grade) === g && String(r.document_type) === d && String(r.student_id) === id,
          r ? `${r.grade}/${r.document_type}/${r.student_id}` : "missing",
        ]);
      }
      return verdict(checks);
    },
  },
];
