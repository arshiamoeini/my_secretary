import fs from "node:fs";
import path from "node:path";

export const read = (dir, rel) => {
  try { return fs.readFileSync(path.join(dir, rel), "utf8"); } catch { return null; }
};
export const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));
export const list = (dir, rel) => {
  try { return fs.readdirSync(path.join(dir, rel), { recursive: true }).map(String); } catch { return []; }
};
export const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

export function parseCsv(text) {
  if (!text) return [];
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((l) => {
    const cells = splitCsvLine(l);
    const row = {};
    header.forEach((h, i) => (row[h] = (cells[i] ?? "").trim()));
    return row;
  });
}
function splitCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === "," && !q) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
export const money = (s) => {
  const m = String(s ?? "").replace(/[,$]/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};
export const num = (s) => money(s);

// Extract "Label: value" from free text (markdown / table / plain).
export function labeled(text, labels) {
  for (const label of labels) {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Require a non-letter before the label so "Total" does not match inside
    // "Subtotal". Allows bullets, bold markers and table pipes around it.
    const re = new RegExp(
      "(?:^|[^A-Za-z])" + esc + "\\s*\\*{0,2}\\s*[:|]\\s*\\*{0,2}\\s*([^\\n|]+)",
      "gi"
    );
    // A table header can contain the label followed by a pipe ("| Line total |"),
    // which would capture whitespace only. Keep looking for a real value.
    for (const m of (text || "").matchAll(re)) {
      const value = m[1].replace(/\*\*/g, "").trim();
      if (/[A-Za-z0-9]/.test(value)) return value;
    }
  }
  return null;
}

export function has(text, ...needles) {
  const t = norm(text);
  return needles.every((n) => t.includes(norm(n)));
}
export function hasAny(text, ...needles) {
  const t = norm(text);
  return needles.some((n) => t.includes(norm(n)));
}

// Build a result from a list of [name, bool, detail?] checks.
export function verdict(checks) {
  const failed = checks.filter((c) => !c[1]);
  return {
    pass: failed.length === 0,
    checks: checks.map(([name, ok, detail]) => ({ name, pass: !!ok, detail: detail ?? "" })),
    detail: failed.length ? "failed: " + failed.map((c) => c[0] + (c[2] ? ` (${c[2]})` : "")).join("; ") : "all checks passed",
  };
}

// JSON file tolerant to surrounding prose / code fences.
export function readJsonLoose(dir, rel) {
  const t = read(dir, rel);
  if (!t) return null;
  const cleaned = t.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < 0) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

export const minutes = (hhmm) => {
  const m = String(hhmm || "").match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
