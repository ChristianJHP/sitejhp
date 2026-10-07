import { unstable_cache } from "next/cache";
import { generateText } from "ai";
import { getBiasSummaryModel, isAiGatewayConfigured } from "@/lib/ai-gateway";
import {
  buildBiasSummaryMarketContext,
  type BiasSummaryMarketContext,
} from "@/lib/bias-summary-context";
import {
  BIAS_SUMMARY_REVALIDATE_SEC,
  BIAS_SUMMARY_CLOSED_REVALIDATE_SEC,
} from "@/lib/bias-summary-config";
import { isFuturesSessionOpen } from "@/lib/futures-session";

export type BiasWatchPayload = {
  items: string[];
  generatedAt?: string;
  configured?: boolean;
  marketOpen?: boolean;
  revalidateSec?: number;
};

const MAX_ITEMS = 3;

function buildPrompt(ctx: BiasSummaryMarketContext): string {
  const closed = !ctx.marketSession.isOpen;

  return `You write a short WATCH LIST for NQ/ES futures traders${closed ? " while CME futures are CLOSED" : ""}.

INPUT JSON:
${JSON.stringify(ctx)}

Return ONLY valid JSON: {"items": ["", "", ""]}

Rules:
- Exactly 2–3 bullets. Each bullet max 14 words. Plain text, no markdown.
- What to KEEP AN EYE ON — levels, timing, ES/NQ divergence, red-folder events, draw on liquidity.
- Use ONLY facts from JSON (prices, drawLevel, fvgNet, distances, smt, nextRedFolderEvent, volatility).
- If volatility.regime is "elevated"/"high", one bullet must name the volatility driver: the red folder release window (event + ET time, pre-release compression/raid) or the war headline theme (escalation vs de-escalation).
- No if/then chains. No trade calls. No hype.
${closed ? "- Markets closed: focus on levels to watch at reopen and upcoming calendar.\n" : "- Include nearest 4H/1H level if within ~30pt.\n"}
Examples: "NQ draw 30536 — 131pt overhead", "1H close in 42m", "Employment report Thu 8:30 ET"`;
}

function parseItems(text: string): string[] | null {
  try {
    const cleaned = text
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    const parsed = JSON.parse(cleaned) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return null;

    const items = parsed.items
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((x) => x.replace(/\*\*/g, "").replace(/\s+/g, " ").trim())
      .slice(0, MAX_ITEMS);

    return items.length >= 2 ? items : null;
  } catch {
    return null;
  }
}

export function formatWatchDeterministic(ctx: BiasSummaryMarketContext): string[] {
  const items: string[] = [];

  const nq4 = ctx.nq.fourHour;
  const draw = ctx.nqWatch.drawLevel;
  if (draw != null && ctx.nq.price != null) {
    const pts = Math.round(Math.abs(draw - ctx.nq.price));
    const dir = ctx.nqWatch.drawSide === "buy-side" ? "↑" : "↓";
    items.push(`NQ draw ${dir} ${draw.toLocaleString()} — ${pts}pt away`);
  } else if (nq4.distToHighPts != null && nq4.distToHighPts <= 30) {
    items.push(`NQ ${Math.round(nq4.distToHighPts)}pt from 4H high ${nq4.high}`);
  } else if (nq4.distToLowPts != null && nq4.distToLowPts <= 30) {
    items.push(`NQ ${Math.round(nq4.distToLowPts)}pt from 4H low ${nq4.low}`);
  }

  if (ctx.smt.message) {
    items.push(ctx.smt.message);
  } else if (
    ctx.relativeStrength.stronger &&
    ctx.relativeStrength.stronger !== "neutral"
  ) {
    items.push(`${ctx.relativeStrength.headline} — watch ES/NQ divergence`);
  }

  if (ctx.nextRedFolderEvent) {
    const e = ctx.nextRedFolderEvent;
    if (e.minutesUntil != null && e.minutesUntil <= 24 * 60) {
      items.push(`${e.title} · ${e.dayEt} ${e.timeEt} ET`);
    }
  }

  if (ctx.marketSession.isOpen && ctx.minutesTo1HClose != null) {
    items.push(`1H candle closes in ${ctx.minutesTo1HClose}m`);
  }

  if (!ctx.marketSession.isOpen) {
    items.unshift(`Markets closed — ${ctx.marketSession.reason}`);
  }

  const unique = [...new Set(items)];
  return unique.slice(0, MAX_ITEMS);
}

async function generateBiasWatch(): Promise<BiasWatchPayload> {
  const ctx = await buildBiasSummaryMarketContext();
  const fallback = formatWatchDeterministic(ctx);
  const generatedAt = new Date().toISOString();
  const marketOpen = ctx.marketSession.isOpen;
  const revalidateSec = marketOpen
    ? BIAS_SUMMARY_REVALIDATE_SEC
    : BIAS_SUMMARY_CLOSED_REVALIDATE_SEC;
  const base = { generatedAt, configured: true, marketOpen, revalidateSec };

  if (!isAiGatewayConfigured()) {
    return { items: fallback, ...base };
  }

  const model = getBiasSummaryModel();
  if (!model) {
    return { items: fallback, ...base };
  }

  try {
    const { text } = await generateText({
      model,
      prompt: buildPrompt(ctx),
      maxOutputTokens: 200,
    });

    const items = parseItems(text) ?? fallback;
    return { items, ...base };
  } catch (error) {
    console.error("[bias/watch] AI failed, using deterministic", error);
    return { items: fallback, ...base };
  }
}

const getCachedBiasWatchOpen = unstable_cache(
  generateBiasWatch,
  ["bias-ai-watch-v2-open"],
  {
    revalidate: BIAS_SUMMARY_REVALIDATE_SEC,
    tags: ["bias-watch", "bias-watch-open"],
  }
);

const getCachedBiasWatchClosed = unstable_cache(
  generateBiasWatch,
  ["bias-ai-watch-v2-closed"],
  {
    revalidate: BIAS_SUMMARY_CLOSED_REVALIDATE_SEC,
    tags: ["bias-watch", "bias-watch-closed"],
  }
);

export async function getCachedBiasWatch(): Promise<BiasWatchPayload> {
  return isFuturesSessionOpen()
    ? getCachedBiasWatchOpen()
    : getCachedBiasWatchClosed();
}
