/**
 * /session-breakdown
 *
 * Interactive TUI that analyzes ~/.pi/agent/sessions (recursively, *.jsonl) and shows
 * last 7/30/90 days or 1 year (365 days) of:
 * - sessions/day
 * - messages/day
 * - tokens/day (if available)
 * - cost/day (if available)
 * - model breakdown (sessions/messages/tokens + cost)
 *
 * Graph:
 * - GitHub-contributions-style calendar (weeks x weekdays)
 * - Hue: weighted mix of popular model colors (weighted by the selected metric)
 * - Brightness: selected metric per day (log-scaled)
 */

import { createReadStream, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  type Component,
  Key,
  Loader,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

type ModelKey = string; // `${provider}/${model}`

interface Activity {
  messages: number;
  tokens: number;
  totalCost: number;
  costByModel: Map<ModelKey, number>;
  messagesByModel: Map<ModelKey, number>;
  tokensByModel: Map<ModelKey, number>;
}

interface ParsedSession extends Activity {
  modelsUsed: Set<ModelKey>;
  startedAt: Date;
  dayKeyLocal: string; // YYYY-MM-DD (local)
  activityByDay: Map<string, Activity>;
}

interface DayAgg {
  date: Date; // local midnight
  dayKeyLocal: string;
  sessions: number;
  messages: number;
  tokens: number;
  totalCost: number;
  costByModel: Map<ModelKey, number>;
  sessionsByModel: Map<ModelKey, number>;
  messagesByModel: Map<ModelKey, number>;
  tokensByModel: Map<ModelKey, number>;
}

interface RangeAgg {
  days: DayAgg[];
  dayByKey: Map<string, DayAgg>;
  sessions: number;
  totalMessages: number;
  totalTokens: number;
  totalCost: number;
  modelCost: Map<ModelKey, number>;
  modelSessions: Map<ModelKey, number>; // number of sessions where model was used
  modelMessages: Map<ModelKey, number>;
  modelTokens: Map<ModelKey, number>;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

interface BreakdownData {
  ranges: Map<number, RangeAgg>;
}

const SESSION_ROOT = path.join(os.homedir(), ".pi", "agent", "sessions");

const RANGE_DAYS = [7, 30, 90, 365] as const;

const MAX_RANGE_DAYS = Math.max(...RANGE_DAYS);

type MeasurementMode = "sessions" | "messages" | "tokens" | "cost";

interface GraphMetric {
  kind: MeasurementMode;
  denom: number;
}

type BreakdownProgressPhase = "scan" | "parse" | "finalize";

interface BreakdownProgressState {
  phase: BreakdownProgressPhase;
  foundFiles: number;
  parsedFiles: number;
  totalFiles: number;
}

// Session entries vary by version. Only require a JSON object here; validate
// individual fields where they are consumed so malformed optional data is ignored.
const fieldsSchema = Type.Object({
  type: Type.Optional(Type.Unknown()),
  id: Type.Optional(Type.Unknown()),
  timestamp: Type.Optional(Type.Unknown()),
  provider: Type.Optional(Type.Unknown()),
  model: Type.Optional(Type.Unknown()),
  modelId: Type.Optional(Type.Unknown()),
  role: Type.Optional(Type.Unknown()),
  toolName: Type.Optional(Type.Unknown()),
  message: Type.Optional(Type.Unknown()),
  messages: Type.Optional(Type.Unknown()),
  usageEntries: Type.Optional(Type.Unknown()),
  details: Type.Optional(Type.Unknown()),
  results: Type.Optional(Type.Unknown()),
  usage: Type.Optional(Type.Unknown()),
  cost: Type.Optional(Type.Unknown()),
  total: Type.Optional(Type.Unknown()),
  totalTokens: Type.Optional(Type.Unknown()),
  total_tokens: Type.Optional(Type.Unknown()),
  tokens: Type.Optional(Type.Unknown()),
  tokenCount: Type.Optional(Type.Unknown()),
  token_count: Type.Optional(Type.Unknown()),
  promptTokens: Type.Optional(Type.Unknown()),
  prompt_tokens: Type.Optional(Type.Unknown()),
  input: Type.Optional(Type.Unknown()),
  output: Type.Optional(Type.Unknown()),
  cacheRead: Type.Optional(Type.Unknown()),
  cacheWrite: Type.Optional(Type.Unknown()),
  inputTokens: Type.Optional(Type.Unknown()),
  input_tokens: Type.Optional(Type.Unknown()),
  completionTokens: Type.Optional(Type.Unknown()),
  completion_tokens: Type.Optional(Type.Unknown()),
  outputTokens: Type.Optional(Type.Unknown()),
  output_tokens: Type.Optional(Type.Unknown()),
});

const stringSchema = Type.String();

const numericSchema = Type.Union([Type.Number(), Type.String()]);

const arraySchema = Type.Array(Type.Unknown());

// Dark-ish background and empty cell color (close to GitHub dark)
const DEFAULT_BG: RGB = { r: 13, g: 17, b: 23 };

const EMPTY_CELL_BG: RGB = { r: 22, g: 27, b: 34 };

// Default palette (assigned to top models)
const PALETTE: RGB[] = [
  { r: 64, g: 196, b: 99 }, // green
  { r: 47, g: 129, b: 247 }, // blue
  { r: 163, g: 113, b: 247 }, // purple
  { r: 255, g: 159, b: 10 }, // orange
  { r: 244, g: 67, b: 54 }, // red
];

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return {
    r: Math.round(lerp(a.r, b.r, t)),
    g: Math.round(lerp(a.g, b.g, t)),
    b: Math.round(lerp(a.b, b.b, t)),
  };
}

function weightedMix(colors: Array<{ color: RGB; weight: number }>): RGB {
  let total = 0;
  let r = 0;
  let g = 0;
  let b = 0;

  for (const c of colors) {
    if (!Number.isFinite(c.weight) || c.weight <= 0) continue;
    total += c.weight;
    r += c.color.r * c.weight;
    g += c.color.g * c.weight;
    b += c.color.b * c.weight;
  }

  if (total <= 0) return EMPTY_CELL_BG;

  return { r: Math.round(r / total), g: Math.round(g / total), b: Math.round(b / total) };
}

function ansiFg(rgb: RGB, text: string): string {
  return `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m${text}\x1b[0m`;
}

function dim(text: string): string {
  return `\x1b[2m${text}\x1b[0m`;
}

function bold(text: string): string {
  return `\x1b[1m${text}\x1b[0m`;
}

function formatCount(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";

  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;

  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;

  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;

  return n.toLocaleString("en-US");
}

function formatUsd(cost: number): string {
  if (!Number.isFinite(cost)) return "$0.00";

  if (cost >= 1) return `$${cost.toFixed(2)}`;

  if (cost >= 0.1) return `$${cost.toFixed(3)}`;

  return `$${cost.toFixed(4)}`;
}

function padRight(s: string, n: number): string {
  const delta = n - s.length;

  return delta > 0 ? s + " ".repeat(delta) : s;
}

function padLeft(s: string, n: number): string {
  const delta = n - s.length;

  return delta > 0 ? " ".repeat(delta) + s : s;
}

function toLocalDayKey(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}`;
}

function localMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function addDaysLocal(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);

  return x;
}

function countDaysInclusiveLocal(start: Date, end: Date): number {
  // Avoid ms-based day math because DST transitions can make a “day” 23/25h in local time.
  let n = 0;

  for (let d = new Date(start); d <= end; d = addDaysLocal(d, 1)) n++;

  return n;
}

function mondayIndex(date: Date): number {
  // Mon=0 .. Sun=6
  return (date.getDay() + 6) % 7;
}

function modelKeyFromParts(provider?: string, model?: string): ModelKey | null {
  const p = provider?.trim() ?? "";
  const m = model?.trim() ?? "";

  if (!p && !m) return null;

  if (!p) return m;

  if (!m) return p;

  return `${p}/${m}`;
}

function parseSessionStartFromFilename(name: string): Date | null {
  // Example: 2026-02-02T21-52-28-774Z_<uuid>.jsonl
  const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/);

  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  const d = new Date(iso);

  return Number.isFinite(d.getTime()) ? d : null;
}

function extractProviderModelAndUsage(obj: Static<typeof fieldsSchema>) {
  // Session format varies across versions.
  // - Newer: { provider, model, usage } on the message wrapper
  // - Older: { message: { provider, model, usage } }
  const msg = Value.Check(fieldsSchema, obj.message) ? obj.message : null;
  const provider = obj.provider ?? msg?.provider;
  const model = obj.model ?? msg?.model;
  const modelId = obj.modelId ?? msg?.modelId;
  const usage = obj.usage ?? msg?.usage;

  return {
    provider: Value.Check(stringSchema, provider) ? provider : undefined,
    model: Value.Check(stringSchema, model) ? model : undefined,
    modelId: Value.Check(stringSchema, modelId) ? modelId : undefined,
    usage: Value.Check(fieldsSchema, usage) ? usage : null,
  };
}

function entryDate(obj: Static<typeof fieldsSchema>, fallback: Date | null): Date | null {
  const message = Value.Check(fieldsSchema, obj.message) ? obj.message : null;

  for (const value of [message?.timestamp, obj.timestamp]) {
    if (!Value.Check(numericSchema, value)) continue;
    const date = new Date(value);

    if (Number.isFinite(date.getTime())) return date;
  }

  return fallback;
}

function firstNumber(...values: unknown[]): number {
  for (const value of values) {
    if (!Value.Check(numericSchema, value)) continue;
    const number = Number(value);

    if (Number.isFinite(number) && number > 0) return number;
  }

  return 0;
}

function extractCostTotal(usage: Static<typeof fieldsSchema> | null): number {
  const costFields = Value.Check(fieldsSchema, usage?.cost) ? usage.cost : null;

  return firstNumber(usage?.cost, costFields?.total);
}

function extractTokensTotal(usage: Static<typeof fieldsSchema> | null): number {
  if (!usage) return 0;

  const tokenFields = Value.Check(fieldsSchema, usage.tokens) ? usage.tokens : null;

  const total = firstNumber(
    usage.totalTokens,
    usage.total_tokens,
    usage.tokens,
    usage.tokenCount,
    usage.token_count,
    tokenFields?.total,
    tokenFields?.totalTokens,
    tokenFields?.total_tokens,
  );

  if (total) return total;

  return (
    firstNumber(
      usage.input,
      usage.promptTokens,
      usage.prompt_tokens,
      usage.inputTokens,
      usage.input_tokens,
    ) +
    firstNumber(
      usage.output,
      usage.completionTokens,
      usage.completion_tokens,
      usage.outputTokens,
      usage.output_tokens,
    ) +
    firstNumber(usage.cacheRead) +
    firstNumber(usage.cacheWrite)
  );
}

function objects(
  obj: Static<typeof fieldsSchema>,
  key: "messages" | "usageEntries" | "results",
): Static<typeof fieldsSchema>[] {
  const value = obj[key];

  if (!Value.Check(arraySchema, value)) return [];

  return value.filter((entry): entry is Static<typeof fieldsSchema> =>
    Value.Check(fieldsSchema, entry),
  );
}

function subagentResults(obj: Static<typeof fieldsSchema>): Static<typeof fieldsSchema>[] | null {
  const message = Value.Check(fieldsSchema, obj.message) ? obj.message : null;

  if (message?.role !== "toolResult" || message.toolName !== "subagent") return null;
  const details = Value.Check(fieldsSchema, message.details) ? message.details : null;

  if (!details) return [];

  return objects(details, "results");
}

function usageTotals(entries: Static<typeof fieldsSchema>[]) {
  let tokens = 0;
  let cost = 0;

  for (const entry of entries) {
    const { usage } = extractProviderModelAndUsage(entry);
    tokens += extractTokensTotal(usage);
    cost += extractCostTotal(usage);
  }

  return { tokens, cost };
}

export async function walkSessionFiles(
  root: string,
  startCutoffLocal: Date,
  signal?: AbortSignal,
  onFound?: (found: number) => void,
): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];

  while (stack.length) {
    if (signal?.aborted) break;
    const dir = stack.pop()!;
    let entries: Dirent[] = [];

    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      if (signal?.aborted) break;
      const p = path.join(dir, ent.name);

      if (ent.isDirectory()) {
        stack.push(p);
        continue;
      }

      if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;

      // Old sessions can contain recent requests. Only mtime can rule them out.
      try {
        const st = await fs.stat(p);
        const approx = new Date(st.mtimeMs);

        if (localMidnight(approx) >= startCutoffLocal) {
          out.push(p);

          if (onFound && out.length % 10 === 0) onFound(out.length);
        }
      } catch {
        // ignore
      }
    }
  }

  onFound?.(out.length);

  return out;
}

export async function parseSessionFile(
  filePath: string,
  signal?: AbortSignal,
  seenEntries = new Set<string>(),
): Promise<ParsedSession | null> {
  const fileName = path.basename(filePath);
  let startedAt = parseSessionStartFromFilename(fileName);
  let currentModel: ModelKey | null = null;

  const modelsUsed = new Set<ModelKey>();
  let messages = 0;
  let tokens = 0;
  let totalCost = 0;
  const costByModel = new Map<ModelKey, number>();
  const messagesByModel = new Map<ModelKey, number>();
  const tokensByModel = new Map<ModelKey, number>();

  const activityByDay = new Map<string, Activity>();

  const activity = (obj: Static<typeof fieldsSchema>, fallback?: Date): Activity | null => {
    const date = entryDate(obj, fallback ?? startedAt);

    if (!date) return null;
    const key = toLocalDayKey(date);
    let day = activityByDay.get(key);

    if (!day) {
      day = {
        messages: 0,
        tokens: 0,
        totalCost: 0,
        costByModel: new Map(),
        messagesByModel: new Map(),
        tokensByModel: new Map(),
      };
      activityByDay.set(key, day);
    }

    return day;
  };

  const addUsage = (mk: ModelKey, tokenCount: number, cost: number, day: Activity | null) => {
    if (day) {
      day.tokens += tokenCount;
      day.totalCost += cost;
      day.tokensByModel.set(mk, (day.tokensByModel.get(mk) ?? 0) + tokenCount);
      day.costByModel.set(mk, (day.costByModel.get(mk) ?? 0) + cost);
    }

    if (tokenCount > 0) {
      tokens += tokenCount;
      tokensByModel.set(mk, (tokensByModel.get(mk) ?? 0) + tokenCount);
    }

    if (cost > 0) {
      totalCost += cost;
      costByModel.set(mk, (costByModel.get(mk) ?? 0) + cost);
    }
  };

  const recordUsage = (
    obj: Static<typeof fieldsSchema>,
    fallbackModel?: ModelKey,
    fallbackDate?: Date,
  ) => {
    const { provider, model, modelId, usage } = extractProviderModelAndUsage(obj);

    if (!usage) return;

    const mk =
      modelKeyFromParts(provider, model ?? modelId) ?? fallbackModel ?? currentModel ?? "unknown";

    modelsUsed.add(mk);
    addUsage(mk, extractTokensTotal(usage), extractCostTotal(usage), activity(obj, fallbackDate));
  };

  const recordMessage = (
    obj: Static<typeof fieldsSchema>,
    fallbackModel?: ModelKey | null,
    includeUsage = true,
    fallbackDate?: Date,
  ) => {
    const { provider, model, modelId, usage } = extractProviderModelAndUsage(obj);

    const mk =
      modelKeyFromParts(provider, model) ??
      modelKeyFromParts(provider, modelId) ??
      fallbackModel ??
      currentModel ??
      "unknown";

    modelsUsed.add(mk);
    messages += 1;
    messagesByModel.set(mk, (messagesByModel.get(mk) ?? 0) + 1);

    const day = activity(obj, fallbackDate);

    if (day) {
      day.messages += 1;
      day.messagesByModel.set(mk, (day.messagesByModel.get(mk) ?? 0) + 1);
    }

    if (includeUsage) addUsage(mk, extractTokensTotal(usage), extractCostTotal(usage), day);
  };

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (signal?.aborted) {
        rl.close();
        stream.destroy();

        return null;
      }

      if (!line) continue;
      let parsed: unknown;

      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (!Value.Check(fieldsSchema, parsed)) continue;

      const obj = parsed;

      if (!startedAt && obj.type === "session" && Value.Check(stringSchema, obj.timestamp)) {
        const d = new Date(obj.timestamp);

        if (Number.isFinite(d.getTime())) startedAt = d;
        continue;
      }

      if (obj?.type === "model_change") {
        const mk = modelKeyFromParts(
          Value.Check(stringSchema, obj.provider) ? obj.provider : undefined,
          Value.Check(stringSchema, obj.modelId) ? obj.modelId : undefined,
        );

        if (mk) {
          currentModel = mk;
          modelsUsed.add(mk);
        }

        continue;
      }

      // Forked session files can copy the same billed entries. Do not dedupe
      // by usage values: two real requests can have identical token counts.
      if (Value.Check(stringSchema, obj.id) && Value.Check(stringSchema, obj.timestamp)) {
        const identity = `${obj.id}/${obj.timestamp}`;

        if (seenEntries.has(identity)) continue;
        seenEntries.add(identity);
      }

      if (obj.type !== "message") {
        // Compactions, branch summaries, and standalone usage are not messages.
        recordUsage(obj);

        continue;
      }

      const children = subagentResults(obj);

      if (children === null) {
        recordMessage(obj);
        continue;
      }

      // Detailed requests and usage entries are the same spend as their aggregates.
      // Reconcile each child first so known models survive incomplete details.
      recordMessage(obj, null, false);
      const fallbackDate = entryDate(obj, startedAt) ?? undefined;
      let childTokens = 0;
      let childCost = 0;

      for (const child of children) {
        const { provider, model, modelId, usage } = extractProviderModelAndUsage(child);
        const mk = modelKeyFromParts(provider, model ?? modelId) ?? "subagent/unknown";
        const messages = objects(child, "messages");
        const entries = objects(child, "usageEntries");

        for (const message of messages) recordMessage(message, mk, true, fallbackDate);

        for (const entry of entries) recordUsage(entry, mk, fallbackDate);

        const detailed = usageTotals([...messages, ...entries]);
        const missingTokens = Math.max(0, extractTokensTotal(usage) - detailed.tokens);
        const missingCost = Math.max(0, extractCostTotal(usage) - detailed.cost);

        if (missingTokens > 0 || missingCost > 1e-12) {
          modelsUsed.add(mk);
          addUsage(mk, missingTokens, missingCost, activity(child, fallbackDate));
        }

        childTokens += detailed.tokens + missingTokens;
        childCost += detailed.cost + missingCost;
      }

      const { usage: aggregate } = extractProviderModelAndUsage(obj);
      const missingTokens = Math.max(0, extractTokensTotal(aggregate) - childTokens);
      const missingCost = Math.max(0, extractCostTotal(aggregate) - childCost);

      if (missingTokens > 0 || missingCost > 1e-12) {
        const mk = "subagent/unknown";
        modelsUsed.add(mk);
        addUsage(mk, missingTokens, missingCost, activity(obj));
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (!startedAt) return null;
  const dayKeyLocal = toLocalDayKey(startedAt);

  return {
    startedAt,
    dayKeyLocal,
    activityByDay,
    modelsUsed,
    messages,
    tokens,
    totalCost,
    costByModel,
    messagesByModel,
    tokensByModel,
  };
}

export function buildRangeAgg(days: number, now: Date): RangeAgg {
  const end = localMidnight(now);
  const start = addDaysLocal(end, -(days - 1));
  const outDays: DayAgg[] = [];
  const dayByKey = new Map<string, DayAgg>();

  for (let i = 0; i < days; i++) {
    const d = addDaysLocal(start, i);
    const dayKeyLocal = toLocalDayKey(d);

    const day: DayAgg = {
      date: d,
      dayKeyLocal,
      sessions: 0,
      messages: 0,
      tokens: 0,
      totalCost: 0,
      costByModel: new Map(),
      sessionsByModel: new Map(),
      messagesByModel: new Map(),
      tokensByModel: new Map(),
    };

    outDays.push(day);
    dayByKey.set(dayKeyLocal, day);
  }

  return {
    days: outDays,
    dayByKey,
    sessions: 0,
    totalMessages: 0,
    totalTokens: 0,
    totalCost: 0,
    modelCost: new Map(),
    modelSessions: new Map(),
    modelMessages: new Map(),
    modelTokens: new Map(),
  };
}

export function addSessionToRange(range: RangeAgg, session: ParsedSession): void {
  // Session counts remain starts/day; activity is independently dated.
  const startDay = range.dayByKey.get(session.dayKeyLocal);

  if (startDay) {
    range.sessions += 1;
    startDay.sessions += 1;

    for (const mk of session.modelsUsed) {
      startDay.sessionsByModel.set(mk, (startDay.sessionsByModel.get(mk) ?? 0) + 1);
      range.modelSessions.set(mk, (range.modelSessions.get(mk) ?? 0) + 1);
    }
  }

  for (const [key, activity] of session.activityByDay) {
    const day = range.dayByKey.get(key);

    if (!day) continue;
    range.totalMessages += activity.messages;
    range.totalTokens += activity.tokens;
    range.totalCost += activity.totalCost;
    day.messages += activity.messages;
    day.tokens += activity.tokens;
    day.totalCost += activity.totalCost;

    for (const [mk, n] of activity.messagesByModel) {
      day.messagesByModel.set(mk, (day.messagesByModel.get(mk) ?? 0) + n);
      range.modelMessages.set(mk, (range.modelMessages.get(mk) ?? 0) + n);
    }

    for (const [mk, n] of activity.tokensByModel) {
      day.tokensByModel.set(mk, (day.tokensByModel.get(mk) ?? 0) + n);
      range.modelTokens.set(mk, (range.modelTokens.get(mk) ?? 0) + n);
    }

    for (const [mk, cost] of activity.costByModel) {
      day.costByModel.set(mk, (day.costByModel.get(mk) ?? 0) + cost);
      range.modelCost.set(mk, (range.modelCost.get(mk) ?? 0) + cost);
    }
  }
}

function sortMapByValueDesc<K extends string>(m: Map<K, number>): Array<{ key: K; value: number }> {
  return [...m.entries()].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value);
}

function choosePalette(range: RangeAgg, topN = 4) {
  // Prefer cost if any cost exists, else tokens, else messages, else sessions.
  const costSum = [...range.modelCost.values()].reduce((a, b) => a + b, 0);
  let popularity = range.modelSessions;

  if (range.totalMessages > 0) popularity = range.modelMessages;

  if (range.totalTokens > 0) popularity = range.modelTokens;

  if (costSum > 0) popularity = range.modelCost;

  const sorted = sortMapByValueDesc(popularity);
  const orderedModels = sorted.slice(0, topN).map((x) => x.key);
  const modelColors = new Map<ModelKey, RGB>();

  for (let i = 0; i < orderedModels.length; i++) {
    modelColors.set(orderedModels[i], PALETTE[i % PALETTE.length]);
  }

  return {
    modelColors,
    otherColor: { r: 160, g: 160, b: 160 },
    orderedModels,
  };
}

function dayMixedColor(
  day: DayAgg,
  modelColors: Map<ModelKey, RGB>,
  otherColor: RGB,
  mode: MeasurementMode,
): RGB {
  const parts: Array<{ color: RGB; weight: number }> = [];
  let otherWeight = 0;

  let map = day.sessionsByModel;

  if (mode === "messages" && day.messages > 0) map = day.messagesByModel;

  if (mode === "tokens") {
    if (day.messages > 0) map = day.messagesByModel;

    if (day.tokens > 0) map = day.tokensByModel;
  }

  if (mode === "cost" && day.totalCost > 0) map = day.costByModel;

  for (const [mk, w] of map.entries()) {
    const c = modelColors.get(mk);

    if (c) parts.push({ color: c, weight: w });
    else otherWeight += w;
  }

  if (otherWeight > 0) parts.push({ color: otherColor, weight: otherWeight });

  return weightedMix(parts);
}

function graphMetricForRange(range: RangeAgg, mode: MeasurementMode): GraphMetric {
  if (mode === "cost") {
    const maxCost = Math.max(0, ...range.days.map((d) => d.totalCost));

    if (maxCost > 0) return { kind: "cost", denom: Math.log1p(maxCost) };
    mode = "tokens";
  }

  if (mode === "tokens") {
    const maxTokens = Math.max(0, ...range.days.map((d) => d.tokens));

    if (maxTokens > 0) return { kind: "tokens", denom: Math.log1p(maxTokens) };
    // fall back if tokens aren't available
    mode = "messages";
  }

  if (mode === "messages") {
    const maxMessages = Math.max(0, ...range.days.map((d) => d.messages));

    if (maxMessages > 0) return { kind: "messages", denom: Math.log1p(maxMessages) };
    // fall back if messages aren't available
    mode = "sessions";
  }

  const maxSessions = Math.max(0, ...range.days.map((d) => d.sessions));

  return { kind: "sessions", denom: Math.log1p(maxSessions) };
}

function weeksForRange(range: RangeAgg): number {
  const days = range.days;
  const start = days[0].date;
  const end = days[days.length - 1].date;
  const gridStart = addDaysLocal(start, -mondayIndex(start));
  const gridEnd = addDaysLocal(end, 6 - mondayIndex(end));
  const totalGridDays = countDaysInclusiveLocal(gridStart, gridEnd);

  return Math.ceil(totalGridDays / 7);
}

function renderGraphLines(
  range: RangeAgg,
  modelColors: Map<ModelKey, RGB>,
  otherColor: RGB,
  mode: MeasurementMode,
  options?: { cellWidth?: number; gap?: number },
): string[] {
  const days = range.days;
  const start = days[0].date;
  const end = days[days.length - 1].date;

  const gridStart = addDaysLocal(start, -mondayIndex(start));
  const gridEnd = addDaysLocal(end, 6 - mondayIndex(end));
  const totalGridDays = countDaysInclusiveLocal(gridStart, gridEnd);
  const weeks = Math.ceil(totalGridDays / 7);

  const cellWidth = Math.max(1, Math.floor(options?.cellWidth ?? 1));
  const gap = Math.max(0, Math.floor(options?.gap ?? 1));
  const block = "█".repeat(cellWidth);
  const gapStr = " ".repeat(gap);

  const metric = graphMetricForRange(range, mode);
  const denom = metric.denom;

  // Label only Mon/Wed/Fri like GitHub (saves space)
  const labelByRow = new Map<number, string>([
    [0, "Mon"],
    [2, "Wed"],
    [4, "Fri"],
  ]);

  const lines: string[] = [];

  for (let row = 0; row < 7; row++) {
    const label = labelByRow.get(row);
    let line = label ? `${padRight(label, 3)} ` : "    ";

    for (let w = 0; w < weeks; w++) {
      const cellDate = addDaysLocal(gridStart, w * 7 + row);
      const inRange = cellDate >= start && cellDate <= end;
      const colGap = w < weeks - 1 ? gapStr : "";

      if (!inRange) {
        line += " ".repeat(cellWidth) + colGap;
        continue;
      }

      const key = toLocalDayKey(cellDate);
      const day = range.dayByKey.get(key);
      const value = day ? dayMetricValue(day, metric.kind) : 0;

      if (!day || value <= 0) {
        line += ansiFg(EMPTY_CELL_BG, block) + colGap;
        continue;
      }

      const hue = dayMixedColor(day, modelColors, otherColor, metric.kind);
      let t = denom > 0 ? Math.log1p(value) / denom : 0;
      t = clamp01(t);
      const minVisible = 0.2;
      const intensity = minVisible + (1 - minVisible) * t;
      const rgb = mixRgb(DEFAULT_BG, hue, intensity);
      line += ansiFg(rgb, block) + colGap;
    }

    lines.push(line);
  }

  return lines;
}

function dayMetricValue(day: DayAgg, mode: MeasurementMode): number {
  if (mode === "cost") return day.totalCost;

  return day[mode];
}

function displayModelName(modelKey: string): string {
  const idx = modelKey.indexOf("/");

  return idx === -1 ? modelKey : modelKey.slice(idx + 1);
}

function renderLegendItems(
  modelColors: Map<ModelKey, RGB>,
  orderedModels: ModelKey[],
  otherColor: RGB,
): string[] {
  const items: string[] = [];

  for (const mk of orderedModels) {
    const c = modelColors.get(mk);

    if (!c) continue;
    items.push(`${ansiFg(c, "█")} ${displayModelName(mk)}`);
  }

  items.push(`${ansiFg(otherColor, "█")} other`);

  return items;
}

function renderModelTable(range: RangeAgg, mode: MeasurementMode, maxRows = 8): string[] {
  // Keep this relatively narrow: model + selected metric + cost + share.
  const metric = graphMetricForRange(range, mode);
  const kind = metric.kind;

  let perModel: Map<ModelKey, number>;
  let total = 0;
  const label = kind;

  if (kind === "cost") {
    perModel = range.modelCost;
    total = range.totalCost;
  } else if (kind === "tokens") {
    perModel = range.modelTokens;
    total = range.totalTokens;
  } else if (kind === "messages") {
    perModel = range.modelMessages;
    total = range.totalMessages;
  } else {
    perModel = range.modelSessions;
    total = range.sessions;
  }

  const sorted = sortMapByValueDesc(perModel);
  const rows = sorted.slice(0, maxRows);

  const valueWidth = kind === "tokens" || kind === "cost" ? 10 : 8;
  const modelWidth = Math.min(52, Math.max("model".length, ...rows.map((r) => r.key.length)));

  const lines: string[] = [];

  if (kind === "cost") {
    lines.push(
      `${padRight("model", modelWidth)}  ${padLeft(label, valueWidth)}  ${padLeft("share", 6)}`,
    );
    lines.push(`${"-".repeat(modelWidth)}  ${"-".repeat(valueWidth)}  ${"-".repeat(6)}`);
  } else {
    lines.push(
      `${padRight("model", modelWidth)}  ${padLeft(label, valueWidth)}  ${padLeft("cost", 10)}  ${padLeft("share", 6)}`,
    );
    lines.push(
      `${"-".repeat(modelWidth)}  ${"-".repeat(valueWidth)}  ${"-".repeat(10)}  ${"-".repeat(6)}`,
    );
  }

  for (const r of rows) {
    const value = perModel.get(r.key) ?? 0;
    const share = total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
    const valueText = kind === "cost" ? formatUsd(value) : formatCount(value);
    const row = `${padRight(r.key.slice(0, modelWidth), modelWidth)}  ${padLeft(valueText, valueWidth)}`;

    if (kind === "cost") {
      lines.push(`${row}  ${padLeft(share, 6)}`);
      continue;
    }

    const cost = range.modelCost.get(r.key) ?? 0;
    lines.push(`${row}  ${padLeft(formatUsd(cost), 10)}  ${padLeft(share, 6)}`);
  }

  if (sorted.length === 0) {
    lines.push(dim("(no model data found)"));
  }

  return lines;
}

function rangeSummary(range: RangeAgg, days: number, mode: MeasurementMode): string {
  // Spend in this window can belong to sessions started before it.
  const costPart = `${formatUsd(range.totalCost)} recorded-equivalent`;

  if (mode === "tokens") {
    return `Last ${days} days: ${formatCount(range.sessions)} sessions · ${formatCount(range.totalTokens)} tokens · ${costPart}`;
  }

  if (mode === "messages") {
    return `Last ${days} days: ${formatCount(range.sessions)} sessions · ${formatCount(range.totalMessages)} messages · ${costPart}`;
  }

  return `Last ${days} days: ${formatCount(range.sessions)} sessions · ${costPart}`;
}

async function computeBreakdown(
  signal?: AbortSignal,
  onProgress?: (update: Partial<BreakdownProgressState>) => void,
): Promise<BreakdownData> {
  const now = new Date();
  const ranges = new Map<number, RangeAgg>();

  for (const d of RANGE_DAYS) ranges.set(d, buildRangeAgg(d, now));
  const start = ranges.get(MAX_RANGE_DAYS)!.days[0].date;

  onProgress?.({
    phase: "scan",
    foundFiles: 0,
    parsedFiles: 0,
    totalFiles: 0,
  });

  const candidates = await walkSessionFiles(SESSION_ROOT, start, signal, (found) => {
    onProgress?.({ phase: "scan", foundFiles: found });
  });

  const totalFiles = candidates.length;
  onProgress?.({
    phase: "parse",
    foundFiles: totalFiles,
    totalFiles,
    parsedFiles: 0,
  });

  let parsedFiles = 0;
  const seenEntries = new Set<string>();

  for (const filePath of candidates) {
    if (signal?.aborted) break;
    parsedFiles += 1;
    onProgress?.({ phase: "parse", parsedFiles, totalFiles });

    const session = await parseSessionFile(filePath, signal, seenEntries);

    if (!session) continue;

    for (const range of ranges.values()) addSessionToRange(range, session);
  }

  onProgress?.({ phase: "finalize" });

  return { ranges };
}

export class BreakdownComponent implements Component {
  private data: BreakdownData;
  private tui: Pick<TUI, "requestRender">;
  private onDone: () => void;
  private rangeIndex = 1; // default 30d
  private measurement: MeasurementMode = "sessions";
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(data: BreakdownData, tui: Pick<TUI, "requestRender">, onDone: () => void) {
    this.data = data;
    this.tui = tui;
    this.onDone = onDone;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      data.toLowerCase() === "q"
    ) {
      this.onDone();

      return;
    }

    if (
      matchesKey(data, Key.tab) ||
      matchesKey(data, Key.shift("tab")) ||
      data.toLowerCase() === "t"
    ) {
      const order: MeasurementMode[] = ["sessions", "messages", "tokens", "cost"];
      const idx = Math.max(0, order.indexOf(this.measurement));
      const dir = matchesKey(data, Key.shift("tab")) ? -1 : 1;
      this.measurement = order[(idx + order.length + dir) % order.length] ?? "sessions";
      this.invalidate();
      this.tui.requestRender();

      return;
    }

    let nextIndex: number | undefined;

    if (matchesKey(data, Key.left) || data.toLowerCase() === "h") {
      nextIndex = this.rangeIndex - 1;
    } else if (matchesKey(data, Key.right) || data.toLowerCase() === "l") {
      nextIndex = this.rangeIndex + 1;
    } else if (data === "1" || data === "2" || data === "3" || data === "4") {
      nextIndex = Number(data) - 1;
    }

    if (nextIndex === undefined) return;

    this.rangeIndex = (nextIndex + RANGE_DAYS.length) % RANGE_DAYS.length;
    this.invalidate();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

    const selectedDays = RANGE_DAYS[this.rangeIndex];
    const range = this.data.ranges.get(selectedDays)!;
    const metric = graphMetricForRange(range, this.measurement);

    const tab = (days: number, idx: number): string => {
      const selected = idx === this.rangeIndex;
      let label = `${days}d`;

      if (days === 365) label = "1y";

      return selected ? bold(`[${label}]`) : dim(` ${label} `);
    };

    const metricTab = (mode: MeasurementMode, label: string): string => {
      const selected = mode === this.measurement;

      return selected ? bold(`[${label}]`) : dim(` ${label} `);
    };

    const header =
      `${bold("Session breakdown")}  ${RANGE_DAYS.map(tab).join(" ")}  ` +
      `${metricTab("sessions", "sess")} ${metricTab("messages", "msg")} ${metricTab("tokens", "tok")} ${metricTab("cost", "cost")}`;

    const palette = choosePalette(range);
    const legendTitle = dim(`Top models (${selectedDays}d palette):`);

    const legendItems = renderLegendItems(
      palette.modelColors,
      palette.orderedModels,
      palette.otherColor,
    );

    const summary =
      rangeSummary(range, selectedDays, metric.kind) + dim(`   (graph: ${metric.kind}/day)`);

    const maxScale = 4 - this.rangeIndex;
    const weeks = weeksForRange(range);
    const leftMargin = 4; // "Mon " (or 4 spaces)
    const graphArea = Math.max(1, width - leftMargin);
    let gap = 1;

    if (weeks * 2 - 1 > graphArea) gap = 0;
    // Each week column uses cellWidth + gap, except the last has no gap.
    const idealCellWidth = Math.floor((graphArea + gap) / Math.max(1, weeks)) - gap;
    const cellWidth = Math.min(maxScale, Math.max(1, idealCellWidth));

    const graphLines = renderGraphLines(
      range,
      palette.modelColors,
      palette.otherColor,
      this.measurement,
      { cellWidth, gap },
    );

    const tableLines = renderModelTable(range, metric.kind, 8);

    const lines: string[] = [];
    lines.push(truncateToWidth(header, width));
    lines.push(truncateToWidth(dim("←/→ range · tab metric · q to close"), width));
    lines.push("");
    lines.push(truncateToWidth(summary, width));
    lines.push("");

    // Render legend on the RIGHT of the graph if there is space.
    const graphWidth = Math.max(0, ...graphLines.map((l) => visibleWidth(l)));
    const sep = 2;
    const legendWidth = width - graphWidth - sep;
    const showSideLegend = legendWidth >= 22;

    if (showSideLegend) {
      const legendBlock: string[] = [];
      legendBlock.push(legendTitle);
      legendBlock.push(...legendItems);
      // Fit into 7 rows (same as graph). If too many, show a final "+N more" line.
      const maxLegendRows = graphLines.length;
      let legendLines = legendBlock.slice(0, maxLegendRows);

      if (legendBlock.length > maxLegendRows) {
        const remaining = legendBlock.length - (maxLegendRows - 1);
        legendLines = [...legendBlock.slice(0, maxLegendRows - 1), dim(`+${remaining} more`)];
      }

      while (legendLines.length < graphLines.length) legendLines.push("");

      const padRightAnsi = (s: string, target: number): string => {
        const w = visibleWidth(s);

        return w >= target ? s : s + " ".repeat(target - w);
      };

      for (let i = 0; i < graphLines.length; i++) {
        const left = padRightAnsi(graphLines[i] ?? "", graphWidth);
        const right = truncateToWidth(legendLines[i] ?? "", Math.max(0, legendWidth));
        lines.push(truncateToWidth(left + " ".repeat(sep) + right, width));
      }
    } else {
      // Fallback: graph only (legend will be shown below).
      for (const gl of graphLines) lines.push(truncateToWidth(gl, width));
      lines.push("");
      // Compact legend below, left-aligned.
      lines.push(truncateToWidth(legendTitle, width));

      for (const it of legendItems) lines.push(truncateToWidth(it, width));
    }

    lines.push("");

    for (const tl of tableLines) lines.push(truncateToWidth(tl, width));

    // Ensure no overly long lines (truncateToWidth already), but keep at least 1 line.
    this.cachedWidth = width;
    this.cachedLines = lines.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width) : l));

    return this.cachedLines;
  }
}

export default function sessionBreakdownExtension(pi: ExtensionAPI) {
  pi.registerCommand("session-breakdown", {
    description:
      "Interactive breakdown of last 7/30/90 days or 1 year of ~/.pi session usage (sessions/messages/tokens + cost by model)",
    handler: async (_args, ctx: ExtensionContext) => {
      if (ctx.mode !== "tui") {
        // Non-interactive fallback.
        const data = await computeBreakdown(undefined);
        const range = data.ranges.get(30)!;
        pi.sendMessage(
          {
            customType: "session-breakdown",
            content: `Session breakdown (non-interactive)\n${rangeSummary(range, 30, "sessions")}`,
            display: true,
          },
          { triggerTurn: false },
        );

        return;
      }

      let aborted = false;

      const data = await ctx.ui.custom<BreakdownData | null>((tui, theme, _kb, done) => {
        const baseMessage = `Analyzing sessions (last ${MAX_RANGE_DAYS} days)…`;
        const loader = new BorderedLoader(tui, theme, baseMessage);

        const startedAt = Date.now();

        const progress: BreakdownProgressState = {
          phase: "scan",
          foundFiles: 0,
          parsedFiles: 0,
          totalFiles: 0,
        };

        const renderMessage = (): string => {
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

          if (progress.phase === "scan") {
            return `${baseMessage}  scanning (${formatCount(progress.foundFiles)} files) · ${elapsed}s`;
          }

          if (progress.phase === "parse") {
            return `${baseMessage}  parsing (${formatCount(progress.parsedFiles)}/${formatCount(progress.totalFiles)}) · ${elapsed}s`;
          }

          return `${baseMessage}  finalizing · ${elapsed}s`;
        };

        // BorderedLoader exposes its children, but not a message setter.
        const progressLoader = loader.children.find((child) => child instanceof Loader);

        if (!progressLoader) throw new Error("BorderedLoader has no Loader child");

        // Update every 0.5s so long-running scans show some visible progress.
        progressLoader.setMessage(renderMessage());

        const intervalId = setInterval(() => {
          progressLoader.setMessage(renderMessage());
        }, 500);

        const stopTicker = () => clearInterval(intervalId);

        loader.onAbort = () => {
          aborted = true;
          stopTicker();
          done(null);
        };

        computeBreakdown(loader.signal, (update) => Object.assign(progress, update))
          .then((d) => {
            stopTicker();

            if (!aborted) done(d);
          })
          .catch((err) => {
            stopTicker();
            console.error("session-breakdown: failed to analyze sessions", err);

            if (!aborted) done(null);
          });

        return loader;
      });

      if (!data) {
        ctx.ui.notify(
          aborted ? "Cancelled" : "Failed to analyze sessions",
          aborted ? "info" : "error",
        );

        return;
      }

      await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
        return new BreakdownComponent(data, tui, done);
      });
    },
  });
}
