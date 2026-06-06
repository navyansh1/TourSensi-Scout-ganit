// Robust CSV/Excel/JSON ingest of "my existing locations".
// Trick: instead of forcing a fixed schema, we ask Gemini to map the user's
// columns onto our canonical schema { name, address, lat, lng, branchId, type }.

import * as XLSX from "xlsx";
import Papa from "papaparse";
import { VertexAI } from "@google-cloud/vertexai";

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "toursensi-ganit-71c77";

export interface CanonicalLocation {
  name: string;
  address?: string;
  lat?: number;
  lng?: number;
  branchId?: string;
  type?: string;
  raw: Record<string, any>;
}

export interface ParsedFile {
  rows: Record<string, any>[];
  headers: string[];
}

export function parseFile(buf: Buffer, filename: string): ParsedFile {
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "csv" || ext === "tsv" || ext === "txt") {
    const text = buf.toString("utf8");
    const parsed = Papa.parse<Record<string, any>>(text, { header: true, skipEmptyLines: true, dynamicTyping: true });
    return { rows: parsed.data, headers: parsed.meta.fields ?? [] };
  }
  if (ext === "json") {
    const data = JSON.parse(buf.toString("utf8"));
    const rows: Record<string, any>[] = Array.isArray(data) ? data : Array.isArray(data?.locations) ? data.locations : [data];
    const headers: string[] = Array.from(new Set(rows.flatMap(r => Object.keys(r ?? {}))));
    return { rows, headers };
  }
  // xlsx, xls
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows: Record<string, any>[] = XLSX.utils.sheet_to_json(sheet, { defval: null });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  return { rows, headers };
}

// Ask Gemini (via Vertex AI) to map arbitrary headers onto canonical fields.
export async function suggestColumnMapping(headers: string[], sampleRows: Record<string, any>[]): Promise<Record<string, string>> {
  const vertex = new VertexAI({ project: PROJECT_ID, location: "us-central1" });
  const model = vertex.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `You are mapping a user-uploaded location dataset onto a canonical schema.

Canonical fields: name, address, lat, lng, branchId, type
- "name": branch/store name, e.g. "HDFC Bank Anna Nagar"
- "address": full street address
- "lat", "lng": numeric coordinates
- "branchId": internal branch/store ID
- "type": category like "ATM", "Branch", "Warehouse", "Store"

User-uploaded columns: ${JSON.stringify(headers)}
Sample rows: ${JSON.stringify(sampleRows.slice(0, 3))}

Respond ONLY with strict JSON of the shape:
{"name": "<column_name_or_null>", "address": "...", "lat": "...", "lng": "...", "branchId": "...", "type": "..."}
Use null for any canonical field that has no match.`;

  const resp = await model.generateContent(prompt);
  const candidate: any = resp.response?.candidates?.[0];
  const text = candidate?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "{}";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    return JSON.parse(match[0]);
  } catch {
    return {};
  }
}

export function applyMapping(rows: Record<string, any>[], mapping: Record<string, string | null>): CanonicalLocation[] {
  return rows.map(r => {
    const name = mapping.name ? r[mapping.name] : undefined;
    const lat = mapping.lat ? toNum(r[mapping.lat]) : undefined;
    const lng = mapping.lng ? toNum(r[mapping.lng]) : undefined;
    return {
      name: String(name ?? "Unnamed"),
      address: mapping.address ? String(r[mapping.address] ?? "") : undefined,
      lat,
      lng,
      branchId: mapping.branchId ? String(r[mapping.branchId] ?? "") : undefined,
      type: mapping.type ? String(r[mapping.type] ?? "") : undefined,
      raw: r,
    };
  }).filter(l => l.name);
}

function toNum(v: any): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}
