import { fetchCalendarMeta, pickNextHighImpact } from "@/lib/events";
import { getMarketSession } from "@/lib/futures-session";
import { computeMarketContext, type SymbolContext } from "@/lib/htf-status";
import { shouldShowDrawOnLiquidity } from "@/lib/market-analysis";
import { withTimeout } from "@/lib/fetch-timeout";
import { gatherGeopoliticsSources } from "@/lib/geopolitics-sources";
import {
  computeSessionVolatility,
  type SessionVolatilityContext,
} from "@/lib/session-volatility";

export type IntervalSnapshot = {
  candleColor: string | null;
  high: number | null;
  low: number | null;
  pctInRange: number | null;
  distToHighPts: number | null;
  distToLowPts: number | null;
};

export type SymbolSnapshot = {
  price: number | null;
  fourHour: IntervalSnapshot;
  oneHour: IntervalSnapshot;
};

export type MarketSessionSnapshot = {
  isOpen: boolean;
  reason: string;
  minutesUntilOpen: number | null;
  minutesUntilClose: number | null;
};

export type SymbolWatchHints = {
  drawLevel: number | null;
  drawSide: "buy-side" | "sell-side" | null;
  fvgNet: number | null;
};

export type BiasSummaryMarketContext = {
  timezone: "America/New_York";
  marketSession: MarketSessionSnapshot;
  nq: SymbolSnapshot;
  es: SymbolSnapshot;
  nqWatch: SymbolWatchHints;
  esWatch: SymbolWatchHints;
  relativeStrength: {
    stronger: "ES" | "NQ" | "neutral" | null;
    headline: string | null;
    nqPtsFromH4High: number | null;
    esPtsFromH4High: number | null;
  };
  smt: {
    type: "bearish" | "bullish" | null;
    message: string | null;
  };
  nextRedFolderEvent: {
    title: string;
    dayEt: string;
    timeEt: string;
    minutesUntil: number | null;
  } | null;
  minutesTo1HClose: number | null;
  /** Red folder timeline + war/geo flow → expected session volatility. */
  volatility: SessionVolatilityContext;
};

const EMPTY_INTERVAL: IntervalSnapshot = {
  candleColor: null,
  high: null,
  low: null,
  pctInRange: null,
  distToHighPts: null,
  distToLowPts: null,
};

function colorLabel(label: string): string | null {
  if (!label || label === "—") return null;
  return label;
}

function interval4h(s: SymbolContext): IntervalSnapshot {
  if (!s.current || !s.h4High || !s.h4Low) return { ...EMPTY_INTERVAL };

  return {
    candleColor: colorLabel(s.fourHour.colorLabel),
    high: s.h4High,
    low: s.h4Low,
    pctInRange: s.pctInH4Range,
    distToHighPts: s.distances.toH4High,
    distToLowPts: s.distances.toH4Low,
  };
}

function interval1h(s: SymbolContext): IntervalSnapshot {
  if (!s.current || !s.h1High || !s.h1Low) return { ...EMPTY_INTERVAL };

  return {
    candleColor: colorLabel(s.oneHour.colorLabel),
    high: s.h1High,
    low: s.h1Low,
    pctInRange: s.pctInH1Range,
    distToHighPts: s.distances.toH1High,
    distToLowPts: s.distances.toH1Low,
  };
}

function symbolSnapshot(s: SymbolContext): SymbolSnapshot {
  return {
    price: s.current || null,
    fourHour: interval4h(s),
    oneHour: interval1h(s),
  };
}

function watchHints(s: SymbolContext): SymbolWatchHints {
  const showDraw = shouldShowDrawOnLiquidity(s.analysis.fvgBias);
  return {
    drawLevel: showDraw ? s.analysis.drawLevel : null,
    drawSide: showDraw ? s.analysis.drawSide : null,
    fvgNet: s.analysis.fvgScore.net ?? null,
  };
}

export async function buildBiasSummaryMarketContext(): Promise<BiasSummaryMarketContext> {
  const [markets, cal, geoSources] = await Promise.all([
    computeMarketContext(),
    fetchCalendarMeta(),
    withTimeout(gatherGeopoliticsSources(), 8_000, "geo sources").catch(
      () => null
    ),
  ]);

  const next = pickNextHighImpact(cal.events);
  const rs = markets.relativeStrength;
  const session = getMarketSession();
  const volatility = computeSessionVolatility(cal.events, geoSources, {
    marketOpen: session.isOpen,
  });

  return {
    timezone: "America/New_York",
    marketSession: {
      isOpen: session.isOpen,
      reason: session.reason,
      minutesUntilOpen: session.minutesUntilOpen,
      minutesUntilClose: session.minutesUntilClose,
    },
    nq: symbolSnapshot(markets.nq),
    es: symbolSnapshot(markets.es),
    nqWatch: watchHints(markets.nq),
    esWatch: watchHints(markets.es),
    relativeStrength: {
      stronger: rs.stronger ?? null,
      headline: rs.headline || null,
      nqPtsFromH4High: Number.isFinite(rs.nqPtsFromH4High)
        ? rs.nqPtsFromH4High
        : null,
      esPtsFromH4High: Number.isFinite(rs.esPtsFromH4High)
        ? rs.esPtsFromH4High
        : null,
    },
    smt: markets.smt
      ? { type: markets.smt.type, message: markets.smt.message }
      : { type: null, message: null },
    nextRedFolderEvent: next
      ? {
          title: next.title,
          dayEt: next.dayEt,
          timeEt: next.timeEt,
          minutesUntil: Math.max(
            0,
            Math.round(
              (new Date(next.scheduledAt).getTime() - Date.now()) / 60_000
            )
          ),
        }
      : null,
    minutesTo1HClose: session.minutesTo1HClose,
    volatility,
  };
}

export type BiasScenariosContext = BiasSummaryMarketContext & {
  upcomingRedFolderEvents: {
    title: string;
    dayEt: string;
    timeEt: string;
  }[];
  headlines: string[];
};

export async function buildBiasScenariosContext(): Promise<BiasScenariosContext> {
  const { fetchHeadlinesMeta } = await import("@/lib/headlines");
  const [base, cal, headlinesPayload] = await Promise.all([
    buildBiasSummaryMarketContext(),
    fetchCalendarMeta(),
    fetchHeadlinesMeta(),
  ]);

  return {
    ...base,
    upcomingRedFolderEvents: cal.events.slice(0, 6).map((e) => ({
      title: e.title,
      dayEt: e.dayEt,
      timeEt: e.timeEt,
    })),
    headlines: headlinesPayload.marketMoving
      .slice(0, 5)
      .map((h) => h.title),
  };
}
