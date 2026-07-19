import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { UsageInfo } from "./slack";

// RunCat Neo が読み取るスナップショットの出力先（statusline.py と同じ既定パス・同じ環境変数で上書き可能）
const RUNCAT_OUT_FILE =
  process.env.RUNCAT_OUT_FILE ?? join(process.env.HOME ?? homedir(), ".claude", "runcat-usage.json");

const JST = "Asia/Tokyo";

export interface RuncatMetric {
  title: string;
  formattedValue: string;
  normalizedValue: number;
}

export interface RuncatSnapshot {
  title: string;
  symbol: string;
  metrics: RuncatMetric[];
  metricsBarValue?: string;
  lastUpdatedDate: string;
}

/** Python の `%g` 相当。有効数字6桁に丸めつつ末尾の 0 を落とす（12.0 → "12"、12.3456789 → "12.3457"） */
function formatG(value: number): string {
  return String(Number(value.toPrecision(6)));
}

function jstFields(date: Date): { month: string; day: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: JST,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  return { month: pick("month"), day: pick("day"), hour: pick("hour"), minute: pick("minute") };
}

const MINUTE_MS = 60_000;

/** 秒以下を切り上げて分境界に揃える（14:59:59 → 15:00:00）。リセット時刻は :59 秒で返るため、そのまま切り捨て表示すると 1 分手前に見える */
function ceilToMinute(date: Date): Date {
  const remainder = date.getTime() % MINUTE_MS;
  return remainder === 0 ? date : new Date(date.getTime() + (MINUTE_MS - remainder));
}

function parseResetsAt(isoString: string): Date | null {
  const date = new Date(isoString);
  return Number.isNaN(date.getTime()) ? null : ceilToMinute(date);
}

/** 'HH:MM' 形式。日を跨ぐ場合は 'MM/DD HH:MM' として日付も付ける。不正値は空文字。 */
export function resetStamp(isoString: string, now: Date = new Date()): string {
  const date = parseResetsAt(isoString);
  if (!date) return "";
  const reset = jstFields(date);
  const today = jstFields(now);
  const time = `${reset.hour}:${reset.minute}`;
  if (reset.month === today.month && reset.day === today.day) return time;
  return `${reset.month}/${reset.day} ${time}`;
}

/** 'HH' のみ。バーのように幅が限られる用途向け。不正値は空文字。 */
export function resetHour(isoString: string): string {
  const date = parseResetsAt(isoString);
  return date ? jstFields(date).hour : "";
}

function metric(title: string, pct: number, resetsAt: string, now: Date): RuncatMetric {
  const stamp = resetStamp(resetsAt, now);
  return {
    title,
    formattedValue: `${formatG(pct)}%` + (stamp ? ` ↻${stamp}` : ""),
    normalizedValue: Math.round((pct / 100) * 10000) / 10000,
  };
}

export function buildRuncatSnapshot(usage: UsageInfo, now: Date = new Date()): RuncatSnapshot {
  // バーは狭いので % は省き、5h のリセットを時 (HH) だけ添える
  const bar = `${formatG(usage.fiveHourUtilization)}/${formatG(usage.sevenDayUtilization)}`;
  const stamp = resetHour(usage.fiveHourResetsAt);
  return {
    title: "Claude Code",
    symbol: "staroflife",
    metrics: [
      metric("5h", usage.fiveHourUtilization, usage.fiveHourResetsAt, now),
      metric("7d", usage.sevenDayUtilization, usage.sevenDayResetsAt, now),
    ],
    metricsBarValue: stamp ? `${bar} ↻${stamp}` : bar,
    lastUpdatedDate: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

/**
 * RunCat Neo 用のスナップショットを書き出す。
 * RunCat 側が読み取り中の中途半端な内容を掴まないよう、一時ファイルへ書いてから rename で差し替える。
 */
export function writeRuncatUsage(usage: UsageInfo, outFile: string = RUNCAT_OUT_FILE): void {
  const snapshot = buildRuncatSnapshot(usage);
  const dir = dirname(outFile);
  const tmp = join(dir, `.runcat-${process.pid}-${Date.now()}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(snapshot), "utf-8");
    renameSync(tmp, outFile);
  } catch (err) {
    rmSync(tmp, { force: true });
    console.error(`[runcat] Failed to write ${outFile}: ${err}`);
  }
}
