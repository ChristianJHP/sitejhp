import type { EconomicEvent } from "@/lib/events";
import { getZonedParts } from "@/lib/et-time";
import { classifyHeadline } from "@/lib/headline-classifier";
import {
  isWarUpdateHeadline,
  type GeopoliticsSources,
} from "@/lib/geopolitics-sources";
import { formatNoTradeWindow } from "@/lib/red-folder-t1";

const TZ = "America/New_York";

export type VolatilityRegime = "calm" | "elevated" | "high";

/**
 * Where the session sits relative to the next red folder release.
 * - imminent: ≤15m — liquidity pulls, spreads widen, stop runs both sides
 * - anticipation: ≤2h — pre-release compression / positioning chop
 * - today: later this ET day — session likely builds a range around the release
 * - tomorrow: ≤24h — de-risking / lighter conviction into the print
 * - later: further out — little direct session impact
 */
export type RedFolderPhase =
  | "none"
  | "later"
  | "tomorrow"
  | "today"
  | "anticipation"
  | "imminent";

export type WarIntensity = "none" | "low" | "elevated" | "high";
export type WarTone = "escalation" | "de-escalation" | "mixed" | "none";

export type RedFolderVolatility = {
  phase: RedFolderPhase;
  next: {
    title: string;
    dayEt: string;
    timeEt: string;
    minutesUntil: number;
    noTradeWindow: string;
  } | null;
  /** All tier-1 releases left in the current ET day. */
  todayEvents: { title: string; timeEt: string; minutesUntil: number }[];
  /** Tier-1 releases within the next 7 days (for weekly positioning). */
  weekCount: number;
  note: string;
};

export type WarVolatility = {
  intensity: WarIntensity;
  tone: WarTone;
  /** War / geo headlines from the last 12h, newest first. */
  headlines: string[];
  /** Trump Truth Social posts touching war/geo topics. */
  trumpPosts: string[];
  /** Freshest war headline age in minutes (null when none). */
  freshestMinutesAgo: number | null;
  note: string;
};

export type SessionVolatilityContext = {
  regime: VolatilityRegime;
  /** 0–10 heuristic; higher = more expected range expansion / whipsaw. */
  score: number;
  drivers: string[];
  redFolder: RedFolderVolatility;
  war: WarVolatility;
  /** Deterministic expected session behavior hint for the model / fallback copy. */
  expectedBehavior: string;
};

const ESCALATION =
  /(strike|strikes|missile|attack|invasion|invade|retaliat|escalat|bomb|explosion|killed|drone|shelling|mobiliz|blockade|hormuz|nuclear|warship|airstrike|declares war|troops)/i;
const DE_ESCALATION =
  /(ceasefire|cease-fire|truce|peace talk|talks|negotiat|deal|de-escalat|withdraw|agreement|summit|prisoner swap)/i;

const WAR_LOOKBACK_MS = 12 * 60 * 60 * 1000;

function etDayKey(date: Date): string {
  const p = getZonedParts(date, TZ);
  return `${p.year}-${p.month}-${p.day}`;
}

function minutesUntil(iso: string, nowMs: number): number {
  return Math.max(0, Math.round((new Date(iso).getTime() - nowMs) / 60_000));
}

function phaseFor(minutes: number, sameDay: boolean): RedFolderPhase {
  if (minutes <= 15) return "imminent";
  if (minutes <= 120) return "anticipation";
  if (sameDay) return "today";
  if (minutes <= 24 * 60) return "tomorrow";
  return "later";
}

function redFolderNote(
  phase: RedFolderPhase,
  title: string | null,
  timeEt: string | null,
  todayCount: number
): string {
  const ev = title ? `${title}${timeEt ? ` ${timeEt} ET` : ""}` : "";
  const fomc = title === "FOMC Meeting";
  switch (phase) {
    case "imminent":
      return `${ev} imminent — expect liquidity pull, spread widening and a stop run on both sides before direction.`;
    case "anticipation":
      return fomc
        ? `${ev} ahead — expect pre-statement compression, then a two-wave move (statement, then presser).`
        : `${ev} ahead — expect compression/chop as positions square; pre-release range highs/lows are the liquidity targets.`;
    case "today":
      return todayCount > 1
        ? `${todayCount} red folder releases today — session likely builds and then expands around ${ev}.`
        : `Session likely centered on ${ev} — early range can be a trap; expansion more likely after the print.`;
    case "tomorrow":
      return `${ev} tomorrow — anticipation may cap follow-through and keep ranges tighter into the release.`;
    case "later":
      return `Next red folder ${ev} — not a session driver yet.`;
    default:
      return "No tier-1 red folder on the calendar.";
  }
}

export function computeRedFolderVolatility(
  events: EconomicEvent[],
  now = new Date()
): RedFolderVolatility {
  const nowMs = now.getTime();
  const todayKey = etDayKey(now);
  const upcoming = events
    .filter((e) => new Date(e.scheduledAt).getTime() > nowMs)
    .sort(
      (a, b) =>
        new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
    );

  const todayEvents = upcoming
    .filter((e) => etDayKey(new Date(e.scheduledAt)) === todayKey)
    .map((e) => ({
      title: e.title,
      timeEt: e.timeEt,
      minutesUntil: minutesUntil(e.scheduledAt, nowMs),
    }));

  const weekCount = upcoming.filter(
    (e) => new Date(e.scheduledAt).getTime() - nowMs <= 7 * 24 * 60 * 60 * 1000
  ).length;

  const nextEvent = upcoming[0] ?? null;
  if (!nextEvent) {
    return {
      phase: "none",
      next: null,
      todayEvents,
      weekCount,
      note: redFolderNote("none", null, null, 0),
    };
  }

  const mins = minutesUntil(nextEvent.scheduledAt, nowMs);
  const sameDay = etDayKey(new Date(nextEvent.scheduledAt)) === todayKey;
  const phase = phaseFor(mins, sameDay);

  return {
    phase,
    next: {
      title: nextEvent.title,
      dayEt: nextEvent.dayEt,
      timeEt: nextEvent.timeEt,
      minutesUntil: mins,
      noTradeWindow: formatNoTradeWindow(nextEvent.timeEt),
    },
    todayEvents,
    weekCount,
    note: redFolderNote(phase, nextEvent.title, nextEvent.timeEt, todayEvents.length),
  };
}

export function computeWarVolatility(
  sources: Pick<GeopoliticsSources, "headlines" | "trumpGeoPosts"> | null,
  now = new Date()
): WarVolatility {
  const empty: WarVolatility = {
    intensity: "none",
    tone: "none",
    headlines: [],
    trumpPosts: [],
    freshestMinutesAgo: null,
    note: "No war/geo headline risk in feed.",
  };
  if (!sources) return empty;

  const nowMs = now.getTime();
  const recent = (iso: string) => {
    const t = new Date(iso).getTime();
    return Number.isNaN(t) || nowMs - t <= WAR_LOOKBACK_MS;
  };

  const war = sources.headlines.filter(
    (h) => recent(h.publishedAt) && isWarUpdateHeadline(h.title)
  );
  const trump = sources.trumpGeoPosts.filter((p) => recent(p.publishedAt));

  if (!war.length && !trump.length) return empty;

  const texts = [...war.map((h) => h.title), ...trump.map((p) => p.text)];
  const escalation = texts.filter((t) => ESCALATION.test(t)).length;
  const deEscalation = texts.filter((t) => DE_ESCALATION.test(t)).length;
  const critical = war.filter((h) => classifyHeadline(h.title) === "critical").length;

  const ages = war
    .map((h) => nowMs - new Date(h.publishedAt).getTime())
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  const freshestMinutesAgo = ages.length
    ? Math.round(Math.min(...ages) / 60_000)
    : null;
  const fresh = freshestMinutesAgo != null && freshestMinutesAgo <= 90;

  let points = war.length + trump.length + critical + escalation;
  if (fresh) points += 2;

  const intensity: WarIntensity =
    points >= 7 ? "high" : points >= 3 ? "elevated" : "low";

  const tone: WarTone =
    escalation && deEscalation
      ? "mixed"
      : escalation
        ? "escalation"
        : deEscalation
          ? "de-escalation"
          : "mixed";

  const toneNote =
    tone === "escalation"
      ? "escalation headlines skew risk-off (NQ/ES offered, gold/oil bid) with gap/spike risk"
      : tone === "de-escalation"
        ? "de-escalation headlines can trigger sharp relief squeezes in NQ/ES and gold giveback"
        : "two-way war headlines raise whipsaw risk on each new wire";

  return {
    intensity,
    tone,
    headlines: war.slice(0, 5).map((h) => h.title),
    trumpPosts: trump.slice(0, 3).map((p) => p.text.slice(0, 160)),
    freshestMinutesAgo,
    note: `${intensity === "high" ? "Active" : intensity === "elevated" ? "Elevated" : "Background"} war/geo flow — ${toneNote}.`,
  };
}

const PHASE_POINTS: Record<RedFolderPhase, number> = {
  none: 0,
  later: 0,
  tomorrow: 1,
  today: 2,
  anticipation: 3,
  imminent: 4,
};

const WAR_POINTS: Record<WarIntensity, number> = {
  none: 0,
  low: 0.5,
  elevated: 1.5,
  high: 3,
};

export function computeSessionVolatility(
  events: EconomicEvent[],
  sources: Pick<GeopoliticsSources, "headlines" | "trumpGeoPosts"> | null,
  opts: { marketOpen: boolean; now?: Date }
): SessionVolatilityContext {
  const now = opts.now ?? new Date();
  const redFolder = computeRedFolderVolatility(events, now);
  const war = computeWarVolatility(sources, now);

  const drivers: string[] = [];
  let score = PHASE_POINTS[redFolder.phase] + WAR_POINTS[war.intensity];

  if (redFolder.phase !== "none" && redFolder.phase !== "later") {
    drivers.push(redFolder.note);
  }
  if (redFolder.todayEvents.length > 1) score += 1;
  if (redFolder.next?.title === "FOMC Meeting" && PHASE_POINTS[redFolder.phase] >= 2) {
    score += 1;
  }
  if (war.intensity !== "none" && war.intensity !== "low") {
    drivers.push(war.note);
  }

  // Red folder + active war flow compound: a hot print into fragile risk tone.
  const stacked =
    PHASE_POINTS[redFolder.phase] >= 2 &&
    (war.intensity === "elevated" || war.intensity === "high");
  if (stacked) {
    score += 1;
    drivers.push("Red folder lands on a headline-sensitive tape — reactions can overshoot.");
  }

  if (!opts.marketOpen && war.intensity !== "none") {
    score += 1;
    drivers.push("Market closed with live war flow — reopen gap risk.");
  }

  score = Math.min(10, Math.round(score * 10) / 10);
  const regime: VolatilityRegime =
    score >= 4 ? "high" : score >= 2 ? "elevated" : "calm";

  let expectedBehavior: string;
  if (redFolder.phase === "imminent") {
    expectedBehavior =
      "Stand aside through the release window; let the first spike take liquidity, then read displacement.";
  } else if (redFolder.phase === "anticipation") {
    expectedBehavior =
      "Expect a compressed pre-release range; treat its high/low as liquidity the print will likely raid.";
  } else if (redFolder.phase === "today") {
    expectedBehavior =
      "Session likely builds around the release — early moves may reverse; bigger expansion after the print.";
  } else if (war.intensity === "high") {
    expectedBehavior =
      "Headline-driven tape — wider stops/smaller size; expect sudden spikes that may not hold structure.";
  } else if (redFolder.phase === "tomorrow") {
    expectedBehavior =
      "Anticipation into tomorrow's print may limit follow-through; ranges can stay tight.";
  } else if (war.intensity === "elevated") {
    expectedBehavior =
      "Structure leads, but war headlines can spike price through levels without warning.";
  } else {
    expectedBehavior = "No scheduled or headline catalyst — structure should lead.";
  }

  return { regime, score, drivers, redFolder, war, expectedBehavior };
}

export function volatilityLabel(regime: VolatilityRegime): string {
  if (regime === "high") return "High";
  if (regime === "elevated") return "Elevated";
  return "Calm";
}
