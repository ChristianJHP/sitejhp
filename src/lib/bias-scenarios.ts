import { unstable_cache } from "next/cache";
import { generateText } from "ai";
import { getBiasSummaryModel, isAiGatewayConfigured } from "@/lib/ai-gateway";
import {
  buildBiasScenariosContext,
  type BiasScenariosContext,
} from "@/lib/bias-summary-context";
import { BIAS_SUMMARY_REVALIDATE_SEC, BIAS_SUMMARY_CLOSED_REVALIDATE_SEC } from "@/lib/bias-summary-config";
import { isFuturesSessionOpen } from "@/lib/futures-session";

export type ScenarioItem = {
  if: string;
  then: string;
};

export type BiasScenarios = {
  bullish: ScenarioItem[];
  bearish: ScenarioItem[];
};

export type BiasScenariosPayload = {
  scenarios: BiasScenarios | null;
  generatedAt?: string;
  configured?: boolean;
  marketOpen?: boolean;
  revalidateSec?: number;
};

const MAX_EACH = 2;

function buildPrompt(ctx: BiasScenariosContext): string {
  const closed = !ctx.marketSession.isOpen;

  return `You write SPECULATIVE if/then scenarios for NQ/ES futures traders${closed ? " while CME futures are CLOSED" : ""}.

INPUT JSON:
${JSON.stringify(ctx)}

Return ONLY valid JSON:
{
  "bullish": [{ "if": "", "then": "" }],
  "bearish": [{ "if": "", "then": "" }]
}

Rules:
- Exactly ${MAX_EACH} bullish and ${MAX_EACH} bearish scenarios.
- Each "if" is a condition (level break, red-folder outcome, headline theme). Each "then" is what could happen — speculative, not certain.
- Use only prices/levels from JSON. Use red-folder events from upcomingRedFolderEvents or nextRedFolderEvent. Headlines may inform macro outcome wording only.
- Center scenarios on JSON.volatility: when redFolder.phase is "imminent", "anticipation" or "today", at least one scenario per side must hinge on that release (hot vs soft print, or a raid of the pre-release range). When war.intensity is "elevated"/"high", one scenario must hinge on war escalation vs de-escalation (use only war.headlines/trumpPosts themes).
${closed ? "- Markets are closed: frame scenarios for the next session open / upcoming events, not live intraday action.\n" : ""}- Frame as conditional: "If X … then Y could …" — never state direction as fact.
- Max 22 words per "if" and per "then". Plain text. No markdown.
- Do not repeat the same trigger on both sides.`;
}

function parseScenarios(text: string): BiasScenarios | null {
  try {
    const cleaned = text
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    const parsed = JSON.parse(cleaned) as Partial<BiasScenarios>;
    if (!Array.isArray(parsed.bullish) || !Array.isArray(parsed.bearish)) {
      return null;
    }

    const normalize = (items: unknown[]): ScenarioItem[] =>
      items
        .filter(
          (item): item is ScenarioItem =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as ScenarioItem).if === "string" &&
            typeof (item as ScenarioItem).then === "string"
        )
        .map((item) => ({
          if: item.if.trim(),
          then: item.then.trim(),
        }))
        .slice(0, MAX_EACH);

    const bullish = normalize(parsed.bullish);
    const bearish = normalize(parsed.bearish);
    if (!bullish.length || !bearish.length) return null;

    return { bullish, bearish };
  } catch {
    return null;
  }
}

export function formatScenariosDeterministic(
  ctx: BiasScenariosContext
): BiasScenarios {
  const bullish: ScenarioItem[] = [];
  const bearish: ScenarioItem[] = [];

  const nqH = ctx.nq.fourHour.high;
  const nqL = ctx.nq.fourHour.low;
  const esH = ctx.es.fourHour.high;
  const esL = ctx.es.fourHour.low;

  if (nqH != null) {
    bullish.push({
      if: `NQ breaks and holds above 4H high ${nqH}`,
      then: `ES could catch up toward 4H high ${esH ?? "insufficient data"}`,
    });
  }
  if (nqL != null) {
    bearish.push({
      if: `NQ loses 4H low ${nqL}`,
      then: `ES may slide toward 4H low ${esL ?? "insufficient data"}`,
    });
  }

  const event =
    ctx.nextRedFolderEvent ?? ctx.upcomingRedFolderEvents[0] ?? null;
  if (event) {
    bullish.push({
      if: `${event.title} (${event.dayEt}) prints soft vs expectations`,
      then: `Risk-on relief could lift indices toward overhead 4H levels`,
    });
    bearish.push({
      if: `${event.title} (${event.dayEt}) surprises hot vs expectations`,
      then: `Rates bid / risk-off could press NQ toward lower 4H range`,
    });
  }

  if (!bullish.length) {
    bullish.push({
      if: "insufficient data for level trigger",
      then: "insufficient data",
    });
  }
  if (!bearish.length) {
    bearish.push({
      if: "insufficient data for level trigger",
      then: "insufficient data",
    });
  }

  return {
    bullish: bullish.slice(0, MAX_EACH),
    bearish: bearish.slice(0, MAX_EACH),
  };
}

async function generateBiasScenarios(): Promise<BiasScenariosPayload> {
  const ctx = await buildBiasScenariosContext();
  const fallback = formatScenariosDeterministic(ctx);
  const generatedAt = new Date().toISOString();
  const marketOpen = ctx.marketSession.isOpen;
  const revalidateSec = marketOpen
    ? BIAS_SUMMARY_REVALIDATE_SEC
    : BIAS_SUMMARY_CLOSED_REVALIDATE_SEC;
  const base = { generatedAt, configured: true, marketOpen, revalidateSec };

  if (!isAiGatewayConfigured()) {
    return { scenarios: fallback, ...base };
  }

  const model = getBiasSummaryModel();
  if (!model) {
    return { scenarios: fallback, ...base };
  }

  try {
    const { text } = await generateText({
      model,
      prompt: buildPrompt(ctx),
      maxOutputTokens: 450,
    });

    const scenarios = parseScenarios(text) ?? fallback;

    return { scenarios, ...base };
  } catch (error) {
    console.error("[bias/scenarios] AI failed, using deterministic", error);
    return { scenarios: fallback, ...base };
  }
}

const getCachedBiasScenariosOpen = unstable_cache(
  generateBiasScenarios,
  ["bias-ai-scenarios-v3-open"],
  {
    revalidate: BIAS_SUMMARY_REVALIDATE_SEC,
    tags: ["bias-scenarios", "bias-scenarios-open"],
  }
);

const getCachedBiasScenariosClosed = unstable_cache(
  generateBiasScenarios,
  ["bias-ai-scenarios-v3-closed"],
  {
    revalidate: BIAS_SUMMARY_CLOSED_REVALIDATE_SEC,
    tags: ["bias-scenarios", "bias-scenarios-closed"],
  }
);

export async function getCachedBiasScenarios(): Promise<BiasScenariosPayload> {
  return isFuturesSessionOpen()
    ? getCachedBiasScenariosOpen()
    : getCachedBiasScenariosClosed();
}

export function getBiasScenariosRevalidateSec(): number {
  return isFuturesSessionOpen()
    ? BIAS_SUMMARY_REVALIDATE_SEC
    : BIAS_SUMMARY_CLOSED_REVALIDATE_SEC;
}
