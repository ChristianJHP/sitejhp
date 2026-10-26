import { unstable_cache } from "next/cache";
import { fetchInvestingRedFolder } from "@/lib/investing-calendar";
import { filterRedFolderT1, pickNextRedFolder } from "@/lib/red-folder-t1";

const FF_CALENDAR =
  "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

/** ~3 weeks so month-edge events (e.g. FOMC mid-month) are included */
export const LOOKOUT_MS = 21 * 24 * 60 * 60 * 1000;

export type EventImpact = "high" | "medium";

export interface EconomicEvent {
  title: string;
  scheduledAt: string;
  impact: EventImpact;
  timeEt: string;
  dayEt: string;
}

interface FfRow {
  title: string;
  country: string;
  date: string;
  impact: string;
}

function formatTimeEt(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function formatDayEt(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

async function fetchFfRows(): Promise<FfRow[]> {
  const res = await fetch(FF_CALENDAR, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
    next: { revalidate: 300 },
  });

  if (!res.ok) {
    throw new Error(`ForexFactory calendar ${res.status}`);
  }

  const text = await res.text();
  if (text.trimStart().startsWith("<")) {
    throw new Error("ForexFactory calendar rate limited");
  }

  return JSON.parse(text) as FfRow[];
}

function mapFfRow(row: FfRow): EconomicEvent {
  return {
    title: row.title,
    scheduledAt: new Date(row.date).toISOString(),
    impact: "high",
    timeEt: formatTimeEt(row.date),
    dayEt: formatDayEt(row.date),
  };
}

function filterUpcomingHighUsd(
  rows: FfRow[],
  withinMs: number
): EconomicEvent[] {
  const now = Date.now();
  const cutoff = now + withinMs;

  return rows
    .filter((r) => r.country === "USD" && r.impact === "High")
    .map(mapFfRow)
    .filter((e) => {
      const t = new Date(e.scheduledAt).getTime();
      return t > now && t <= cutoff;
    })
    .sort(
      (a, b) =>
        new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
    );
}

async function fetchRedFolderUncached(): Promise<{
  events: EconomicEvent[];
  source: "forexfactory" | "investing" | "none";
}> {
  let ffOk = false;
  try {
    const rows = await fetchFfRows();
    ffOk = true;
    const events = filterUpcomingHighUsd(rows, LOOKOUT_MS);
    const t1 = filterRedFolderT1(events);
    if (t1.length > 0) {
      return { events: t1, source: "forexfactory" };
    }
  } catch (e) {
    console.warn("[calendar] ForexFactory failed:", (e as Error).message);
  }

  // FF only covers this week — Investing looks further ahead. It is often
  // blocked (403), so a failure here must not take down every consumer:
  // "no tier-1 events this week" is a normal state after the last release.
  try {
    const events = await fetchInvestingRedFolder(LOOKOUT_MS);
    return { events: filterRedFolderT1(events), source: "investing" };
  } catch (e) {
    console.warn("[calendar] Investing failed:", (e as Error).message);
    return { events: [], source: ffOk ? "forexfactory" : "none" };
  }
}

const getCachedRedFolder = unstable_cache(
  fetchRedFolderUncached,
  ["red-folder-calendar-v4"],
  { revalidate: 300, tags: ["calendar"] }
);

/** Red folder (tier 1) USD — next 3 weeks, with fallback if FF is blocked */
export async function fetchRedFolderWeek(): Promise<EconomicEvent[]> {
  const { events } = await getCachedRedFolder();
  return events;
}

export async function fetchCalendarMeta() {
  return getCachedRedFolder();
}

export function pickNextHighImpact(
  events: EconomicEvent[]
): EconomicEvent | null {
  return pickNextRedFolder(events);
}
