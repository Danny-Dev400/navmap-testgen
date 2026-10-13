import type { Locator } from "./navmap-types.js";

/** A form field as recorded on an action (the locator is optional: the dashboard has labels only). */
export interface FieldLike {
  label: string;
  locator?: Locator;
  value: string;
}

/** Rule-based test data — no AI. Input variants per form field (valid / empty / too long / wrong
 *  format…) to fill data tables. Only INPUTS are generated: the expected outcome of an invalid
 *  value is never guessed here — it must be observed on the page (by a person or the designer). */

export type FieldKind = "email" | "postal" | "phone" | "name" | "number" | "password" | "text";

export interface DataVariant {
  label: string;
  value: string;
  intent: "valid" | "invalid";
}

function locatorText(l: Locator): string {
  switch (l.strategy) {
    case "role":
      return `${l.role} ${l.name ?? ""}`;
    case "text":
      return l.text;
    case "label":
      return l.label;
    case "placeholder":
      return l.placeholder;
    case "testId":
      return l.testId;
    case "css":
      return l.css;
  }
}

export function fieldKind(field: FieldLike): FieldKind {
  const hay = `${field.label} ${field.locator ? locatorText(field.locator) : ""}`.toLowerCase();
  if (/pass(word)?|pwd/.test(hay)) return "password";
  if (/e-?mail/.test(hay) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(field.value)) return "email";
  if (/zip|postal|post code|postcode/.test(hay)) return "postal";
  if (/phone|mobile|tel/.test(hay)) return "phone";
  if (/name/.test(hay)) return "name";
  if (/amount|qty|quantity|age|number|count|price/.test(hay) || /^-?\d+(\.\d+)?$/.test(field.value)) return "number";
  return "text";
}

/** Valid = the recorded value; invalid = the classic edge cases for the field's kind. Passwords
 *  only ever get "empty" — credentials and password-like values never go into test data. */
export function variantsFor(field: FieldLike): DataVariant[] {
  const kind = fieldKind(field);
  if (kind === "password") return [{ label: "empty", value: "", intent: "invalid" }];
  const out: DataVariant[] = [
    { label: "valid (recorded)", value: field.value, intent: "valid" },
    { label: "empty", value: "", intent: "invalid" },
    { label: "only spaces", value: "   ", intent: "invalid" },
    { label: "too long (256 chars)", value: "x".repeat(256), intent: "invalid" },
  ];
  if (field.value) out.push({ label: "surrounding spaces", value: `  ${field.value}  `, intent: "invalid" });
  switch (kind) {
    case "email":
      out.push({ label: "not an email", value: "not-an-email", intent: "invalid" }, { label: "missing domain", value: "user@", intent: "invalid" });
      break;
    case "postal":
      out.push({ label: "letters", value: "ABCDE", intent: "invalid" }, { label: "too short", value: "1", intent: "invalid" });
      break;
    case "phone":
      out.push({ label: "letters", value: "phone-number", intent: "invalid" });
      break;
    case "number":
      out.push({ label: "letters", value: "abc", intent: "invalid" }, { label: "negative", value: "-1", intent: "invalid" }, { label: "zero", value: "0", intent: "invalid" });
      break;
    case "name":
      out.push({ label: "digits only", value: "12345", intent: "invalid" }, { label: "symbols", value: "<>@#$%", intent: "invalid" });
      break;
    case "text":
      break;
  }
  return out;
}

export function columnName(label: string): string {
  const words = label.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const camel = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join("");
  const name = /^[a-zA-Z]/.test(camel) ? camel : `field${camel}`;
  return name.slice(0, 30) || "field";
}

/** Data-table rows for one form action: one row per invalid variant of ONE field, the other fields
 *  keeping their recorded (valid) values. Columns = one per field (named from its label). */
export function suggestRows(fields: FieldLike[]): { columns: string[]; fieldColumns: Record<string, string>; rows: { name: string; values: Record<string, string> }[] } {
  const fieldColumns = Object.fromEntries(fields.map((f) => [f.label, columnName(f.label)]));
  const valid = Object.fromEntries(fields.map((f) => [fieldColumns[f.label], fieldKind(f) === "password" ? "" : f.value]));
  const rows: { name: string; values: Record<string, string> }[] = [];
  for (const f of fields) {
    for (const v of variantsFor(f).filter((x) => x.intent === "invalid")) {
      rows.push({ name: `${f.label}: ${v.label}`.slice(0, 80), values: { ...valid, [fieldColumns[f.label]]: v.value } });
    }
  }
  return { columns: Object.values(fieldColumns), fieldColumns, rows: rows.slice(0, 40) };
}
