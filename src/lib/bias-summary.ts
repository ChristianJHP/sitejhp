import { unstable_cache } from "next/cache";
import { generateText } from "ai";
import { getBiasSummaryModel, isAiGatewayConfigured } from "@/lib/ai-gateway";
import {
  buildBiasSummaryMarketContext,
  type BiasSummaryMarketContext,
  type IntervalSnapshot,
  type SymbolSnapshot,
} from "@/lib/bias-summary-context";
import { BIAS_SUMMARY_REVALIDATE_SEC, BIAS_SUMMARY_CLOSED_REVALIDATE_SEC } from "@/lib/bias-summary-config";
import { isFuturesSessionOpen } from "@/lib/futures-session";

export type BiasSummaryPayload = {
  line: string | null;
  generatedAt?: string;
  configured?: boolean;
  marketOpen?: boolean;
  revalidateSec?: number;
};

function formatMinutesUntilOpen(minutes: number | null): string {
  if (minutes == null || minutes <= 0) return "reopens soon";
  if (minutes >= 1440) {
    const days = Math.round(minutes / 1440);
    return `reopens in ${days}d`;
  }
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `reopens in ${h}h ${m}m` : `reopens in ${h}h`;
  }
  return `reopens in ${minutes}m`;
}

function buildPrompt(ctx: BiasSummaryMarketContext): string {
  const closed = !ctx.marketSession.isOpen;

  return `You write ONE sentence on NQ/ES${closed ? " while CME futures are CLOSED" : " for the next hour"}.

INPUT JSON:
${JSON.stringify(ctx)}

Return ONLY valid JSON: {"line": ""}

The sentence must:
${closed
    ? `- State markets are closed (marketSession.reason) and when they reopen (minutesUntilOpen).
- Summarize last known 1H/4H structure and ES vs NQ from JSON — no live "next hour" action.
- Mention nextRedFolderEvent if relevant before reopen.
- If volatility.war.intensity is "elevated"/"high", flag reopen gap risk from war headlines.`
    : `- State current 1H/4H color and where price sits vs the nearest 1H or 4H level (from JSON).
- Mention ES vs NQ strength if not balanced.
- Note 1H candle close in minutesTo1HClose if relevant.
- Frame the next-hour lean around volatility (JSON.volatility): red folder phase "imminent"/"anticipation" → compression into the release then a two-sided liquidity raid; "today" → session building around the release; war intensity "elevated"/"high" → headline spike/whipsaw risk (escalation = risk-off, de-escalation = relief squeeze).
- Name the red folder event + ET time when phase is imminent/anticipation/today.
- If volatility.regime is "calm", give a structure-led lean (grind, chop, test high/low) — speculative, not certain.`}

Rules:
- Exactly ONE sentence, max 45 words. Plain text.
- Use ONLY JSON facts. No chart analysis. Do not invent levels.
- If data missing, say "insufficient data" for that part only.`;
}

function parseLine(text: string): string | null {
  try {
    const cleaned = text
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    const parsed = JSON.parse(cleaned) as { line?: string };
    if (typeof parsed.line !== "string" || !parsed.line.trim()) return null;
    return parsed.line.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  } catch {
    const fallback = text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
    return fallback.length > 10 && fallback.length < 280 ? fallback : null;
  }
}

function nearestTarget(interval: IntervalSnapshot): string | null {
  const { distToHighPts, distToLowPts, high, low, candleColor } = interval;
  if (distToHighPts == null || distToLowPts == null) return null;

  if (distToHighPts <= distToLowPts) {
    return `${distToHighPts}pt from ${candleColor ?? "?"} candle high ${high ?? "?"}`;
  }
  return `${distToLowPts}pt from ${candleColor ?? "?"} candle low ${low ?? "?"}`;
}

function symbolTone(snap: SymbolSnapshot): string {
  const h1 = snap.oneHour.candleColor ?? "?";
  const h4 = snap.fourHour.candleColor ?? "?";
  const near = nearestTarget(snap.oneHour) ?? nearestTarget(snap.fourHour);
  return near ? `1H ${h1}, 4H ${h4}, ${near}` : `1H ${h1}, 4H ${h4}`;
}

export function formatLineDeterministic(ctx: BiasSummaryMarketContext): string {
  if (!ctx.marketSession.isOpen) {
    const rs = ctx.relativeStrength.headline ?? "Balanced";
    const nqPx = ctx.nq.price?.toLocaleString() ?? "?";
    const esPx = ctx.es.price?.toLocaleString() ?? "?";
    const openLabel = formatMinutesUntilOpen(ctx.marketSession.minutesUntilOpen);
    const gap =
      ctx.volatility?.war.intensity === "high" ||
      ctx.volatility?.war.intensity === "elevated"
        ? "; war headlines raise reopen gap risk"
        : "";
    return `Markets closed (${ctx.marketSession.reason}) — ${openLabel}; last NQ ${nqPx}, ES ${esPx}; ${rs}${gap}.`;
  }

  const rs = ctx.relativeStrength.headline ?? "Balanced";
  const nq = symbolTone(ctx.nq);
  const es = symbolTone(ctx.es);

  let lean = "next hour may chop inside the current 1H range";
  const nq1h = ctx.nq.oneHour;
  if (nq1h.distToHighPts != null && nq1h.distToLowPts != null) {
    if (nq1h.distToHighPts <= nq1h.distToLowPts && nq1h.distToHighPts < 20) {
      lean = "next hour may test the 1H high if momentum holds";
    } else if (nq1h.distToLowPts < 20) {
      lean = "next hour may drift toward the 1H low";
    }
  }

  let timing = "";
  if (ctx.minutesTo1HClose != null) {
    timing = `, ${ctx.minutesTo1HClose}m to 1H close`;
  }
  const event = ctx.nextRedFolderEvent;
  if (event?.minutesUntil != null && event.minutesUntil <= 360) {
    timing += `, ${event.title} in ${event.minutesUntil}m`;
  }

  const phase = ctx.volatility?.redFolder.phase;
  if (phase === "imminent" || phase === "anticipation") {
    lean = "compression into the release, then a likely raid of the pre-release range";
  } else if (ctx.volatility?.war.intensity === "high") {
    lean = `${lean}; war headlines can spike price through levels`;
  }

  return `NQ ${nq}; ES ${es}; ${rs}${timing} — ${lean}.`;
}

async function generateBiasSummary(): Promise<BiasSummaryPayload> {
  const ctx = await buildBiasSummaryMarketContext();
  const fallback = formatLineDeterministic(ctx);
  const generatedAt = new Date().toISOString();
  const marketOpen = ctx.marketSession.isOpen;
  const revalidateSec = marketOpen
    ? BIAS_SUMMARY_REVALIDATE_SEC
    : BIAS_SUMMARY_CLOSED_REVALIDATE_SEC;
  const base = { generatedAt, configured: true, marketOpen, revalidateSec };

  if (!isAiGatewayConfigured()) {
    return { line: fallback, ...base };
  }

  const model = getBiasSummaryModel();
  if (!model) {
    return { line: fallback, ...base };
  }

  try {
    const { text } = await generateText({
      model,
      prompt: buildPrompt(ctx),
      maxOutputTokens: 120,
    });

    const line = parseLine(text) ?? fallback;

    return { line, ...base };
  } catch (error) {
    console.error("[bias/summary] failed, using deterministic line", error);
    return { line: fallback, ...base };
  }
}

const getCachedBiasSummaryOpen = unstable_cache(
  generateBiasSummary,
  ["bias-ai-summary-v6-open"],
  {
    revalidate: BIAS_SUMMARY_REVALIDATE_SEC,
    tags: ["bias-summary", "bias-summary-open"],
  }
);

const getCachedBiasSummaryClosed = unstable_cache(
  generateBiasSummary,
  ["bias-ai-summary-v6-closed"],
  {
    revalidate: BIAS_SUMMARY_CLOSED_REVALIDATE_SEC,
    tags: ["bias-summary", "bias-summary-closed"],
  }
);

export async function getCachedBiasSummary(): Promise<BiasSummaryPayload> {
  return isFuturesSessionOpen()
    ? getCachedBiasSummaryOpen()
    : getCachedBiasSummaryClosed();
}

export function getBiasSummaryRevalidateSec(): number {
  return isFuturesSessionOpen()
    ? BIAS_SUMMARY_REVALIDATE_SEC
    : BIAS_SUMMARY_CLOSED_REVALIDATE_SEC;
}

export { BIAS_SUMMARY_REVALIDATE_SEC } from "@/lib/bias-summary-config";
