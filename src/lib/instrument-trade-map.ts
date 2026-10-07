import type { ChartOverlayKey } from "@/lib/chart-overlay-types";
import type { HtfBias, SymbolLabel } from "@/lib/strategy-prep";
import type { InstrumentBiasContext } from "@/lib/instrument-bias-brief";
import {
  volatilityLabel,
  type VolatilityRegime,
} from "@/lib/session-volatility";

export type Confidence = "Low" | "Medium" | "High";

export type OverlayHint = {
  label: string;
};

export type ChartFocusLevels = {
  drawLevel?: number;
  keyLevelLow?: number;
  keyLevelHigh?: number;
  invalidationLevel?: number;
  drawSide?: "buy-side" | "sell-side";
};

export type InstrumentTradeMap = {
  headline: string;
  context: string;
  bias: HtfBias;
  keyLevel: string;
  draw: string;
  invalidation: string;
  confidence: Confidence;
  newsImpact: string;
  newsLine: string;
  /** Expected session volatility regime (red folder + war flow). */
  volatility: VolatilityRegime;
  /** One-line read on volatility centered on red folder / war catalysts. */
  volatilityNote: string;
  overlayHints: Partial<Record<ChartOverlayKey, OverlayHint>>;
  chartFocus: ChartFocusLevels;
};

function displayName(symbol: SymbolLabel): string {
  if (symbol === "GC") return "Gold";
  return symbol;
}

function formatPrice(price: number, symbol: SymbolLabel): string {
  if (symbol === "GC") return price.toFixed(1);
  return Math.round(price).toLocaleString();
}

function formatRange(
  low: number,
  high: number,
  symbol: SymbolLabel
): string {
  const a = Math.min(low, high);
  const b = Math.max(low, high);
  if (Math.abs(b - a) < (symbol === "GC" ? 0.5 : 4)) {
    return formatPrice(b, symbol);
  }
  return `${formatPrice(a, symbol)}–${formatPrice(b, symbol)}`;
}

function biasWord(bias: HtfBias): string {
  if (bias === "bullish") return "Bullish";
  if (bias === "bearish") return "Bearish";
  return "Mixed";
}

function fvgTone(net: number): string {
  if (net <= -2) return "Bearish";
  if (net >= 2) return "Bullish";
  if (net < 0) return "Bearish lean";
  if (net > 0) return "Bullish lean";
  return "Mixed";
}

function sessionWeight(ctx: InstrumentBiasContext): string {
  const s = ctx.sessionLabel.toLowerCase();
  if (!ctx.marketOpen) return "Closed";
  if (s.includes("asia")) return "Low weight";
  if (s.includes("london")) return "Moderate";
  if (s.includes("new york") || s === "ny") return "High weight";
  return "Moderate";
}

function sessionShort(label: string): string {
  const s = label.toLowerCase();
  if (s.includes("asia")) return "Asia";
  if (s.includes("london")) return "London";
  if (s.includes("new york") || s === "ny") return "NY";
  if (s.includes("closed")) return "Closed";
  return label.split("·")[0]?.trim() || label;
}

function deriveFocus(ctx: InstrumentBiasContext): ChartFocusLevels {
  const fvg = ctx.keyLevels.find((l) => l.role === "fvg");
  const intermediate = ctx.keyLevels.find((l) => l.role === "intermediate");
  const cisd = ctx.keyLevels.find((l) => l.role === "cisd");

  let keyLevelLow: number | undefined;
  let keyLevelHigh: number | undefined;
  let invalidationLevel: number | undefined;

  if (fvg) {
    const spread = ctx.symbol === "GC" ? 8 : 35;
    keyLevelLow = fvg.price - spread / 2;
    keyLevelHigh = fvg.price + spread / 2;
    invalidationLevel =
      ctx.perceivedBias === "bearish" ? keyLevelHigh : keyLevelLow;
  } else if (intermediate) {
    keyLevelHigh = intermediate.price;
    keyLevelLow = intermediate.price;
    invalidationLevel = intermediate.price;
  }

  if (ctx.perceivedBias === "bearish" && !invalidationLevel && keyLevelHigh) {
    invalidationLevel = keyLevelHigh;
  }
  if (ctx.perceivedBias === "bullish" && !invalidationLevel && keyLevelLow) {
    invalidationLevel = keyLevelLow;
  }

  if (cisd && !invalidationLevel) {
    invalidationLevel = cisd.price;
  }

  return {
    drawLevel: ctx.drawOnLiquidity?.level,
    drawSide: ctx.drawOnLiquidity?.side as "buy-side" | "sell-side" | undefined,
    keyLevelLow,
    keyLevelHigh,
    invalidationLevel,
  };
}

function deriveKeyLevel(
  ctx: InstrumentBiasContext,
  focus: ChartFocusLevels
): string {
  if (focus.keyLevelLow != null && focus.keyLevelHigh != null) {
    return formatRange(focus.keyLevelLow, focus.keyLevelHigh, ctx.symbol);
  }
  const lvl = ctx.keyLevels[0];
  if (lvl) return formatPrice(lvl.price, ctx.symbol);
  return formatPrice(ctx.price, ctx.symbol);
}

function deriveInvalidation(
  ctx: InstrumentBiasContext,
  focus: ChartFocusLevels
): string {
  const level =
    focus.invalidationLevel ??
    focus.keyLevelHigh ??
    focus.keyLevelLow ??
    ctx.price;

  if (ctx.perceivedBias === "bearish") {
    return `Hold above ${formatPrice(level, ctx.symbol)}`;
  }
  if (ctx.perceivedBias === "bullish") {
    return `Hold below ${formatPrice(level, ctx.symbol)}`;
  }
  return `Break ${formatPrice(level, ctx.symbol)}`;
}

function deriveConfidence(ctx: InstrumentBiasContext): Confidence {
  let score = 0;
  if (ctx.htf.oneHour === ctx.htf.fourHour) score += 1;
  if (ctx.perceivedBias !== "mixed") score += 1;
  if (ctx.esConfirm === true) score += 1;
  if (ctx.drawOnLiquidity) score += 1;

  const weight = sessionWeight(ctx);
  if (weight === "High weight") score += 1;
  if (weight === "Low weight") score -= 1;

  if (ctx.topHeadlines.length > 0 && ctx.perceivedBias !== "mixed") score += 1;

  // Structure is less reliable into a red folder release or under live war flow.
  const phase = ctx.volatility.redFolder.phase;
  if (phase === "imminent") score -= 2;
  else if (phase === "anticipation") score -= 1;
  if (ctx.volatility.war.intensity === "high") score -= 1;

  if (score >= 4) return "High";
  if (score >= 2) return "Medium";
  return "Low";
}

function deriveNewsImpact(ctx: InstrumentBiasContext): string {
  const headlines = ctx.topHeadlines.join(" ").toLowerCase();
  const geo = `${ctx.geo.war} ${ctx.geo.trump ?? ""} ${ctx.geo.marketsTone}`.toLowerCase();
  const war = ctx.volatility.war;
  const warActive = war.intensity === "elevated" || war.intensity === "high";

  if (warActive && war.tone === "escalation") {
    return ctx.symbol === "GC"
      ? "War escalation / gold-supportive"
      : "War escalation / risk-off";
  }
  if (warActive && war.tone === "de-escalation") {
    return ctx.symbol === "GC"
      ? "De-escalation / gold headwind"
      : "De-escalation / relief risk";
  }
  if (warActive) return "Two-way war headlines / whipsaw";

  if (ctx.symbol === "GC") {
    const goldPositive =
      /inflation|stagflation|war|sanction|safe.?haven|fed cut|dollar weak|energy|geopol/i.test(
        `${headlines} ${geo}`
      );
    const goldNegative =
      /strong dollar|rate hike|yields up|risk.?on|dollar firm/i.test(
        `${headlines} ${geo}`
      );
    if (goldPositive && !goldNegative) return "Supportive for gold";
    if (goldNegative && !goldPositive) return "Headwind for gold";
    if (goldPositive && goldNegative) return "Mixed / slightly gold-supportive";
    return "Mixed";
  }

  if (/risk.?on|rally|soft landing|dovish/i.test(`${headlines} ${geo}`)) {
    return "Risk-on / supportive";
  }
  if (/risk.?off|inflation|war|selloff|hawk/i.test(`${headlines} ${geo}`)) {
    return "Risk-off / cautious";
  }
  return "Mixed";
}

function deriveNewsLine(ctx: InstrumentBiasContext): string {
  const war = ctx.volatility.war;
  if (war.intensity === "high" && war.headlines[0]) {
    const h = war.headlines[0];
    return h.length > 100 ? `${h.slice(0, 97).trim()}…` : h;
  }
  if (ctx.topHeadlines[0]) {
    const h = ctx.topHeadlines[0];
    const short = h.length > 90 ? `${h.slice(0, 87).trim()}…` : h;
    if (/disrespect|bearish fvg/i.test(ctx.fvgNarrative)) {
      return `${short} Price still failing under structure.`;
    }
    return short;
  }
  if (ctx.geo.trump) {
    return ctx.geo.trump.length > 100
      ? `${ctx.geo.trump.slice(0, 97).trim()}…`
      : ctx.geo.trump;
  }
  if (ctx.geo.war) {
    return ctx.geo.war.length > 100
      ? `${ctx.geo.war.slice(0, 97).trim()}…`
      : ctx.geo.war;
  }
  return "No major catalyst in feed — lean on structure.";
}

function buildHeadline(ctx: InstrumentBiasContext, keyLevel: string): string {
  const name = displayName(ctx.symbol);
  const bias = biasWord(ctx.perceivedBias);
  const anchor = keyLevel.split("–")[0] ?? keyLevel;

  if (ctx.perceivedBias === "bearish") {
    return `${name} bias: ${bias} below ${anchor}.`;
  }
  if (ctx.perceivedBias === "bullish") {
    return `${name} bias: ${bias} above ${anchor}.`;
  }
  return `${name} bias: ${bias} at ${keyLevel}.`;
}

function catalystSentence(ctx: InstrumentBiasContext): string {
  const { redFolder, war } = ctx.volatility;
  const ev = redFolder.next;
  const evLabel = ev ? `${ev.title} ${ev.timeEt} ET` : "";
  switch (redFolder.phase) {
    case "imminent":
      return `${evLabel} imminent — expect a two-sided spike before bias resolves.`;
    case "anticipation":
      return `Bias likely tested into ${evLabel}; pre-release range is the liquidity target.`;
    case "today":
      return `Session likely centers on ${evLabel} — expect expansion after the print.`;
    default:
      break;
  }
  if (war.intensity === "high" || war.intensity === "elevated") {
    return war.tone === "escalation"
      ? "War escalation flow can spike price through structure — size down."
      : war.tone === "de-escalation"
        ? "De-escalation headlines can squeeze price against the bias."
        : "Two-way war headlines — expect whipsaw around levels.";
  }
  return "Anticipation into the next red folder may cap follow-through.";
}

function deriveVolatilityNote(ctx: InstrumentBiasContext): string {
  const vol = ctx.volatility;
  if (vol.regime === "calm") return vol.expectedBehavior;
  const lead =
    vol.redFolder.phase !== "none" && vol.redFolder.phase !== "later"
      ? vol.redFolder.note
      : vol.war.note;
  return `${volatilityLabel(vol.regime)} vol: ${lead}`;
}

function buildContext(ctx: InstrumentBiasContext): string {
  if (!ctx.marketOpen) {
    return `Markets closed. Last ${formatPrice(ctx.price, ctx.symbol)} with ${ctx.htf.fourHour} 4H / ${ctx.htf.oneHour} 1H into reopen.`;
  }

  const parts: string[] = [];
  const pd =
    ctx.premiumDiscount === "equilibrium"
      ? "mid 4H range"
      : `${ctx.premiumDiscount} (${ctx.htf.pctIn4HRange}% of 4H range)`;

  parts.push(`Price is in 4H ${pd}.`);

  const fvgShort = ctx.fvgNarrative.split(";")[0]?.trim();
  if (fvgShort && ctx.fvgNet !== 0) {
    parts.push(
      `${ctx.htf.oneHour} 1H vs ${ctx.htf.fourHour} 4H — ${fvgShort.toLowerCase()}.`
    );
  } else if (ctx.htf.oneHour !== ctx.htf.fourHour) {
    parts.push(`${ctx.htf.fourHour} 4H vs ${ctx.htf.oneHour} 1H conflict.`);
  }

  if (ctx.drawOnLiquidity) {
    const dir = ctx.perceivedBias === "bearish" ? "downside" : "upside";
    parts.push(
      `Primary ${dir} draw is ${formatPrice(ctx.drawOnLiquidity.level, ctx.symbol)}.`
    );
  }

  const vol = ctx.volatility;
  if (vol.regime !== "calm") {
    return [...parts.slice(0, 2), catalystSentence(ctx)].join(" ");
  }

  const conf = deriveConfidence(ctx);
  parts.push(
    conf === "High"
      ? "Structure and session align — confidence is high."
      : conf === "Medium"
        ? "News is mixed — confidence is moderate, not high."
        : "Thin session or mixed structure — confidence is low."
  );

  return parts.slice(0, 3).join(" ");
}

function buildOverlayHints(
  ctx: InstrumentBiasContext,
  keyLevel: string
): Partial<Record<ChartOverlayKey, OverlayHint>> {
  const keyAnchor = keyLevel.split("–").pop() ?? keyLevel;
  return {
    draw: {
      label: ctx.drawOnLiquidity ? biasWord(ctx.perceivedBias) : "—",
    },
    fvg: { label: fvgTone(ctx.fvgNet) },
    session: {
      label: `${sessionShort(ctx.sessionLabel)} / ${sessionWeight(ctx)}`,
    },
    levels: { label: `${keyAnchor} key` },
    rejection: { label: "Off" },
    cisd: { label: ctx.cisd != null ? "Active" : "Off" },
  };
}

export function buildTradeMapFromContext(
  ctx: InstrumentBiasContext
): InstrumentTradeMap {
  const focus = deriveFocus(ctx);
  const keyLevel = deriveKeyLevel(ctx, focus);
  const draw = ctx.drawOnLiquidity
    ? formatPrice(ctx.drawOnLiquidity.level, ctx.symbol)
    : "—";

  return {
    headline: buildHeadline(ctx, keyLevel),
    context: buildContext(ctx),
    bias: ctx.perceivedBias,
    keyLevel,
    draw,
    invalidation: deriveInvalidation(ctx, focus),
    confidence: deriveConfidence(ctx),
    newsImpact: deriveNewsImpact(ctx),
    newsLine: deriveNewsLine(ctx),
    volatility: ctx.volatility.regime,
    volatilityNote: deriveVolatilityNote(ctx),
    overlayHints: buildOverlayHints(ctx, keyLevel),
    chartFocus: focus,
  };
}

export function mergeTradeMapWithAi(
  base: InstrumentTradeMap,
  ai?: Partial<
    Pick<
      InstrumentTradeMap,
      | "headline"
      | "context"
      | "newsImpact"
      | "newsLine"
      | "invalidation"
      | "volatilityNote"
    >
  > | null
): InstrumentTradeMap {
  if (!ai) return base;
  return {
    ...base,
    headline: ai.headline?.trim() || base.headline,
    context: ai.context?.trim() || base.context,
    newsImpact: ai.newsImpact?.trim() || base.newsImpact,
    newsLine: ai.newsLine?.trim() || base.newsLine,
    invalidation: ai.invalidation?.trim() || base.invalidation,
    volatilityNote: ai.volatilityNote?.trim() || base.volatilityNote,
  };
}
