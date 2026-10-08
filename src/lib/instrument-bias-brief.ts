import { unstable_cache } from "next/cache";
import { generateText } from "ai";
import { getBiasSummaryModel, isAiGatewayConfigured } from "@/lib/ai-gateway";
import {
  BIAS_SUMMARY_CLOSED_REVALIDATE_SEC,
  BIAS_SUMMARY_REACTION_REVALIDATE_SEC,
  BIAS_SUMMARY_REVALIDATE_SEC,
} from "@/lib/bias-summary-config";
import { fetchCalendarMeta, pickNextHighImpact } from "@/lib/events";
import { MARKET_TICKERS } from "@/lib/chart-data";
import { tryLivePrice } from "@/lib/live-quote-fetch";
import { withTimeout } from "@/lib/fetch-timeout";
import { formatGeopoliticsDeterministic } from "@/lib/geopolitics-brief";
import {
  buildMarketNewsFeed,
  gatherGeopoliticsSources,
} from "@/lib/geopolitics-sources";
import { getMarketSession, isFuturesSessionOpen } from "@/lib/futures-session";
import { computeMarketContext, type SymbolContext } from "@/lib/htf-status";
import { filterNewsForInstrument } from "@/lib/instrument-news";
import {
  computeSymbolPrep,
  type HtfBias,
  type SymbolLabel,
} from "@/lib/strategy-prep";
import { getTradingSessionInfo } from "@/lib/trading-session";
import {
  parseModelOverlays,
  resolveSummaryOverlays,
} from "@/lib/summary-chart-overlays";
import type { ChartOverlaySettings } from "@/lib/chart-overlay-types";
import {
  computeSessionVolatility,
  type SessionVolatilityContext,
} from "@/lib/session-volatility";
import {
  buildTradeMapFromContext,
  mergeTradeMapWithAi,
  type InstrumentTradeMap,
} from "@/lib/instrument-trade-map";

/** Cap on the AI refinement; context build is capped at 18s separately. */
const AI_TIMEOUT_MS = 12_000;

export type InstrumentBiasPayload = {
  line: string;
  symbol: SymbolLabel;
  generatedAt: string;
  configured: boolean;
  marketOpen: boolean;
  revalidateSec: number;
  overlays: ChartOverlaySettings;
  tradeMap: InstrumentTradeMap;
};

export type InstrumentBiasContext = {
  symbol: SymbolLabel;
  price: number;
  marketOpen: boolean;
  sessionLabel: string;
  perceivedBias: HtfBias;
  htf: {
    oneHour: string;
    fourHour: string;
    pctIn4HRange: number;
    pctIn1HRange: number;
    distTo4HHighPts: number;
    distTo4HLowPts: number;
  };
  premiumDiscount: "premium" | "discount" | "equilibrium";
  drawOnLiquidity: {
    side: string;
    level: number;
    pointsAway: number;
  } | null;
  fvgNarrative: string;
  fvgNet: number;
  keyLevels: { label: string; price: number; role: string }[];
  cisd: number | null;
  esConfirm: boolean | null;
  relativeStrength: string | null;
  smt: string | null;
  topHeadlines: string[];
  geo: { war: string; trump: string | null; marketsTone: string };
  volatility: SessionVolatilityContext;
  nextRedFolder: { title: string; minutesUntil: number } | null;
  minutesTo1HClose: number | null;
};

function pickSymbol(
  label: SymbolLabel,
  ctx: Awaited<ReturnType<typeof computeMarketContext>>
): SymbolContext {
  if (label === "ES") return ctx.es;
  if (label === "GC") return ctx.gold;
  return ctx.nq;
}

function tickerForLabel(label: SymbolLabel): string {
  if (label === "ES") return MARKET_TICKERS.ES;
  if (label === "GC") return MARKET_TICKERS.GC;
  return MARKET_TICKERS.NQ;
}

async function livePriceForLabel(label: SymbolLabel): Promise<number | null> {
  return tryLivePrice(tickerForLabel(label));
}

async function quickGeoForContext() {
  const sources = await gatherGeopoliticsSources();
  const strings = formatGeopoliticsDeterministic(sources);
  const feed = buildMarketNewsFeed(sources);
  return {
    sources,
    feed,
    war: strings.war,
    trump: strings.trump,
    markets: strings.markets,
  };
}

function premiumDiscountFromPct(pct: number): "premium" | "discount" | "equilibrium" {
  if (pct >= 62) return "premium";
  if (pct <= 38) return "discount";
  return "equilibrium";
}

export async function buildInstrumentBiasContext(
  label: SymbolLabel
): Promise<InstrumentBiasContext> {
  const [market, cal, geo] = await Promise.all([
    withTimeout(computeMarketContext(), 18_000, "market context"),
    fetchCalendarMeta(),
    withTimeout(quickGeoForContext(), 8_000, "geo sources").catch(() => ({
      sources: null,
      feed: [] as Awaited<ReturnType<typeof buildMarketNewsFeed>>,
      war: "",
      trump: null as string | null,
      markets: "",
    })),
  ]);

  const symbol = pickSymbol(label, market);
  const prep = computeSymbolPrep(symbol, market);
  const session = getMarketSession();
  const tradingSession = getTradingSessionInfo();
  const next = pickNextHighImpact(cal.events);
  const volatility = computeSessionVolatility(cal.events, geo.sources, {
    marketOpen: session.isOpen,
  });

  const headlines = filterNewsForInstrument(geo.feed, label, 4).map((h) => h.text);

  let relativeStrength: string | null = null;
  if (label === "NQ" || label === "ES") {
    relativeStrength = market.relativeStrength.headline || null;
    if (prep.esConfirm === true) {
      relativeStrength = `${relativeStrength ?? "ES/NQ"} · ES confirms`;
    } else if (prep.esConfirm === false) {
      relativeStrength = `${relativeStrength ?? "ES/NQ"} · ES diverging`;
    }
  } else if (geo.markets) {
    relativeStrength = geo.markets.slice(0, 80);
  }

  return {
    symbol: label,
    price: Math.round(symbol.current),
    marketOpen: session.isOpen,
    sessionLabel: tradingSession.isMarketOpen
      ? tradingSession.label
      : "Closed",
    perceivedBias: prep.bias,
    htf: {
      oneHour: symbol.oneHour.colorLabel || symbol.oneHour.bias,
      fourHour: symbol.fourHour.colorLabel || symbol.fourHour.bias,
      pctIn4HRange: Math.round(symbol.pctInH4Range),
      pctIn1HRange: Math.round(symbol.pctInH1Range),
      distTo4HHighPts: Math.round(symbol.distances.toH4High),
      distTo4HLowPts: Math.round(symbol.distances.toH4Low),
    },
    premiumDiscount: premiumDiscountFromPct(symbol.pctInH4Range),
    drawOnLiquidity: prep.draw
      ? {
          side: prep.draw.side,
          level: Math.round(prep.draw.level),
          pointsAway: Math.round(prep.draw.pointsAway),
        }
      : null,
    fvgNarrative: prep.fvgNarrative,
    fvgNet: prep.fvgNet,
    keyLevels: prep.keyLevels.slice(0, 4).map((l) => ({
      label: l.label,
      price: Math.round(l.price),
      role: l.role,
    })),
    cisd: symbol.analysis.cisd
      ? Math.round(symbol.analysis.cisd.price)
      : null,
    esConfirm: label === "GC" ? null : prep.esConfirm,
    relativeStrength,
    smt: label === "GC" ? null : market.smt?.message ?? null,
    topHeadlines: headlines,
    geo: {
      war: geo.war,
      trump: geo.trump,
      marketsTone: geo.markets,
    },
    volatility,
    nextRedFolder: next
      ? {
          title: next.title,
          minutesUntil: Math.max(
            0,
            Math.round(
              (new Date(next.scheduledAt).getTime() - Date.now()) / 60_000
            )
          ),
        }
      : null,
    minutesTo1HClose: session.minutesTo1HClose,
  };
}

function buildPrompt(ctx: InstrumentBiasContext): string {
  const closed = !ctx.marketOpen;
  const base = buildTradeMapFromContext(ctx);

  return `You refine a compact trade map for ${ctx.symbol} futures (not trade advice).

INPUT JSON:
${JSON.stringify(ctx)}

DETERMINISTIC DRAFT:
${JSON.stringify(base)}

Return ONLY valid JSON:
{
  "headline": "",
  "context": "",
  "newsImpact": "",
  "newsLine": "",
  "invalidation": "",
  "volatility": "",
  "overlays": {"draw": false, "fvg": false, "rejection": false, "cisd": false, "session": false, "levels": false}
}

Rules:
- headline: one line like "Gold bias: Bearish below 4520." Use ONLY JSON prices.
- context: max 2 short sentences. Mechanical — PD array, HTF, draw, FVG. No fluff.
- newsImpact: short label e.g. "Mixed / slightly gold-supportive"
- newsLine: one sentence catalyst read from headlines/geo
- invalidation: e.g. "Hold above 4527" — use JSON keyLevels/drawOnLiquidity
- volatility: one sentence (max 28 words) on expected session volatility, CENTERED on the red folder timeline and war/geo flow in JSON.volatility.
  - Red folder: use volatility.redFolder.phase/next/todayEvents. "imminent"/"anticipation" → pre-release compression, liquidity raid of the pre-release range, two-sided spike; "today" → session likely builds around the release; "tomorrow" → anticipation caps follow-through. Name the event and ET time.
  - War: use volatility.war (intensity, tone, headlines, trumpPosts). Escalation → risk-off spikes (NQ/ES down, gold up); de-escalation → relief squeezes; mixed → whipsaw. Only cite headlines present in JSON.
  - If both stack, say reactions may overshoot. If regime is "calm", say structure should lead.
- context: when volatility.regime is "elevated" or "high", the final context sentence must tie the bias to the catalyst timing (e.g. bias likely tested into/after the release) instead of generic confidence.
- newsImpact/newsLine: weigh volatility.war and the red folder timing above generic headlines.
- overlays: true ONLY for concepts you reference in headline/context
${closed ? "- Markets closed: frame for next open." : ""}
- Use ONLY JSON facts. Do not invent levels or headlines.`;
}

function parseAiResponse(text: string): {
  tradeMapAi: Partial<
    Pick<
      InstrumentTradeMap,
      | "headline"
      | "context"
      | "newsImpact"
      | "newsLine"
      | "invalidation"
      | "volatilityNote"
    >
  > | null;
  overlays: Partial<ChartOverlaySettings> | null;
} {
  try {
    const cleaned = text
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    const parsed = JSON.parse(cleaned) as {
      headline?: string;
      context?: string;
      newsImpact?: string;
      newsLine?: string;
      invalidation?: string;
      volatility?: string;
      line?: string;
      overlays?: unknown;
    };

    const headline = parsed.headline?.trim() || parsed.line?.trim();
    const context = parsed.context?.trim() || parsed.line?.trim();

    if (!headline && !context) {
      return { tradeMapAi: null, overlays: null };
    }

    return {
      tradeMapAi: {
        headline: headline || undefined,
        context: context || undefined,
        newsImpact: parsed.newsImpact?.trim(),
        newsLine: parsed.newsLine?.trim(),
        invalidation: parsed.invalidation?.trim(),
        volatilityNote: parsed.volatility?.trim(),
      },
      overlays: parseModelOverlays(parsed.overlays),
    };
  } catch {
    return { tradeMapAi: null, overlays: null };
  }
}

function payloadFromContext(
  ctx: InstrumentBiasContext,
  base: Omit<InstrumentBiasPayload, "line" | "overlays" | "tradeMap">,
  tradeMap: InstrumentTradeMap
): InstrumentBiasPayload {
  const summaryText = `${tradeMap.headline} ${tradeMap.context}`;
  return {
    ...base,
    line: summaryText,
    tradeMap,
    overlays: resolveSummaryOverlays(summaryText, ctx),
  };
}

export function formatInstrumentBiasDeterministic(
  ctx: InstrumentBiasContext
): InstrumentTradeMap {
  return buildTradeMapFromContext(ctx);
}

async function generateInstrumentBiasBrief(
  label: SymbolLabel
): Promise<InstrumentBiasPayload> {
  const ctx = await buildInstrumentBiasContext(label);
  const draft = buildTradeMapFromContext(ctx);
  const generatedAt = new Date().toISOString();
  const marketOpen = ctx.marketOpen;
  const revalidateSec = marketOpen
    ? BIAS_SUMMARY_REVALIDATE_SEC
    : BIAS_SUMMARY_CLOSED_REVALIDATE_SEC;

  const base = {
    symbol: label,
    generatedAt,
    configured: isAiGatewayConfigured(),
    marketOpen,
    revalidateSec,
  };

  if (!isAiGatewayConfigured()) {
    return payloadFromContext(ctx, base, draft);
  }

  const model = getBiasSummaryModel();
  if (!model) {
    return payloadFromContext(ctx, base, draft);
  }

  try {
    const { text } = await generateText({
      model,
      prompt: buildPrompt(ctx),
      maxOutputTokens: 380,
      // Finish (AI or fallback) inside the route's cached-brief timeout so the
      // result is always cached — otherwise a paid call is discarded and the
      // next request pays for another.
      abortSignal: AbortSignal.timeout(AI_TIMEOUT_MS),
      maxRetries: 1,
    });
    const parsed = parseAiResponse(text);
    const tradeMap = mergeTradeMapWithAi(draft, parsed.tradeMapAi);
    const summaryText = `${tradeMap.headline} ${tradeMap.context}`;
    return {
      ...base,
      line: summaryText,
      tradeMap,
      overlays: resolveSummaryOverlays(
        summaryText,
        ctx,
        parsed.overlays
      ),
    };
  } catch (error) {
    console.error(`[instrument-bias/${label}]`, error);
    return payloadFromContext(ctx, base, draft);
  }
}

function cacheFor(label: SymbolLabel) {
  const open = unstable_cache(
    () => generateInstrumentBiasBrief(label),
    [`instrument-bias-v3-${label}-open`],
    {
      revalidate: BIAS_SUMMARY_REVALIDATE_SEC,
      tags: ["instrument-bias", `instrument-bias-${label}`],
    }
  );
  const closed = unstable_cache(
    () => generateInstrumentBiasBrief(label),
    [`instrument-bias-v3-${label}-closed`],
    {
      revalidate: BIAS_SUMMARY_CLOSED_REVALIDATE_SEC,
      tags: ["instrument-bias", `instrument-bias-${label}`],
    }
  );
  return { open, closed };
}

const caches = {
  NQ: cacheFor("NQ"),
  ES: cacheFor("ES"),
  GC: cacheFor("GC"),
};

export async function getCachedInstrumentBiasBrief(
  label: SymbolLabel
): Promise<InstrumentBiasPayload> {
  const c = caches[label];
  return isFuturesSessionOpen() ? c.open() : c.closed();
}

/** Fast deterministic trade map — no AI, no 30m cache. */
export async function getDeterministicInstrumentBiasBrief(
  label: SymbolLabel
): Promise<InstrumentBiasPayload> {
  const ctx = await buildInstrumentBiasContext(label);
  const tradeMap = buildTradeMapFromContext(ctx);
  const summaryText = `${tradeMap.headline} ${tradeMap.context}`;
  const marketOpen = ctx.marketOpen;
  return {
    symbol: label,
    generatedAt: new Date().toISOString(),
    configured: isAiGatewayConfigured(),
    marketOpen,
    revalidateSec: marketOpen ? 60 : BIAS_SUMMARY_CLOSED_REVALIDATE_SEC,
    line: summaryText,
    tradeMap,
    overlays: resolveSummaryOverlays(summaryText, ctx),
  };
}

/** Bypass 30m cache — fresh structure + prices after a volatile move. */
export async function getFreshInstrumentBiasBrief(
  label: SymbolLabel,
  liveReaction?: string
): Promise<InstrumentBiasPayload> {
  let ctx = await buildInstrumentBiasContext(label);
  if (ctx.marketOpen) {
    const livePrice = await livePriceForLabel(label);
    if (livePrice != null) ctx = { ...ctx, price: livePrice };
  }

  let tradeMap = buildTradeMapFromContext(ctx);
  if (liveReaction) {
    tradeMap = {
      ...tradeMap,
      context: `${liveReaction} ${tradeMap.context}`,
      newsLine: liveReaction,
    };
  }
  const summaryText = `${tradeMap.headline} ${tradeMap.context}`;
  return {
    symbol: label,
    generatedAt: new Date().toISOString(),
    configured: isAiGatewayConfigured(),
    marketOpen: ctx.marketOpen,
    revalidateSec: BIAS_SUMMARY_REACTION_REVALIDATE_SEC,
    line: summaryText,
    tradeMap,
    overlays: resolveSummaryOverlays(summaryText, ctx),
  };
}
