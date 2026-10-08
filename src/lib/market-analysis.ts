import type { OhlcBar } from "@/lib/ohlc-aggregate";
import { aggregate1h, aggregate4h } from "@/lib/ohlc-aggregate";
import { trimFuturesCandleSeries } from "@/lib/futures-candle-trim";
import type { Candle } from "@/lib/chart-data";
import type { ChartOverlaySettings } from "@/lib/chart-overlay-types";
import {
  detectCisd,
  detectFairValueGaps,
  nearestSwingHigh,
  nearestSwingLow,
  relevantFvgsForChart,
  scoreFvgBias,
  type CisdLevel,
  type FairValueGap,
  type FvgBiasScore,
} from "@/lib/fvg-detect";

export type MarketBias = "bullish" | "bearish" | "mixed";

export type ChartPlotLineRole = "draw" | "cisd" | "level" | "session";

export type ChartPlotLine = {
  price: number;
  color: string;
  style: "solid" | "dashed";
  label?: string;
  role: ChartPlotLineRole;
};

export type ChartPlotZoneKind = "fvg" | "rejection" | "draw-range";

export type ChartPlotZone = {
  top: number;
  bottom: number;
  type: "bullish" | "bearish";
  timeframe: "4H" | "1H" | "15m" | "5m";
  kind: ChartPlotZoneKind;
  label: string;
  /** Unix seconds — where the zone formed */
  startTime: number;
};

export type SymbolChartPlot = {
  lines: ChartPlotLine[];
  zones: ChartPlotZone[];
};

export type SymbolMarketAnalysis = {
  fvgs4h: FairValueGap[];
  fvgs1h: FairValueGap[];
  fvgScore: FvgBiasScore;
  fvgBias: MarketBias;
  fvgNarrative: string;
  cisd: CisdLevel | null;
  drawLevel: number;
  drawSide: "buy-side" | "sell-side";
  swingHigh: number;
  swingLow: number;
  chartPlot: SymbolChartPlot;
};

function deriveFvgBias(score: FvgBiasScore): MarketBias {
  if (score.net >= 2) return "bullish";
  if (score.net <= -2) return "bearish";
  if (score.bullRespected > score.bearRespected && score.bullDisrespected === 0) {
    return "bullish";
  }
  if (score.bearRespected > score.bullRespected && score.bearDisrespected === 0) {
    return "bearish";
  }
  return "mixed";
}

function fvgNarrative(score: FvgBiasScore): string {
  const parts: string[] = [];
  if (score.bullRespected > 0) {
    parts.push(`${score.bullRespected} bull FVG respected`);
  }
  if (score.bullDisrespected > 0) {
    parts.push(`${score.bullDisrespected} bull FVG disrespected`);
  }
  if (score.bearDisrespected > 0) {
    parts.push(`${score.bearDisrespected} bear FVG disrespected`);
  }
  if (score.bearRespected > 0) {
    parts.push(`${score.bearRespected} bear FVG respected`);
  }
  return parts.length ? parts.join(" · ") : "No clear FVG read yet";
}

/** Only bearish bias gets a draw — bullish/mixed at highs has no clean DOL and sell-side below reads bearish. */
export function shouldShowDrawOnLiquidity(fvgBias: MarketBias): boolean {
  return fvgBias === "bearish";
}

/** Draw on liquidity from FVG bias — bearish targets sell-side below. */
export function resolveDraw(
  fvgBias: MarketBias,
  swingHigh: number,
  swingLow: number,
  h4High: number,
  h4Low: number,
  current: number
): { drawSide: "buy-side" | "sell-side"; drawLevel: number } {
  if (fvgBias === "bearish") {
    return {
      drawSide: "sell-side",
      drawLevel: Math.min(swingLow, h4Low),
    };
  }
  if (fvgBias === "bullish") {
    return {
      drawSide: "buy-side",
      drawLevel: Math.max(swingHigh, h4High),
    };
  }
  const mid = (h4High + h4Low) / 2;
  if (current >= mid) {
    return {
      drawSide: "sell-side",
      drawLevel: Math.min(swingLow, h4Low),
    };
  }
  return {
    drawSide: "buy-side",
    drawLevel: Math.max(swingHigh, h4High),
  };
}

export function drawPlotLine(
  drawSide: "buy-side" | "sell-side",
  drawLevel: number
): ChartPlotLine {
  return {
    price: drawLevel,
    color:
      drawSide === "buy-side"
        ? "rgba(96, 165, 250, 0.85)"
        : "rgba(251, 146, 60, 0.85)",
    style: "dashed",
    label: drawSide === "buy-side" ? "Draw ↑" : "Draw ↓",
    role: "draw",
  };
}

export function fvgToChartZone(fvg: FairValueGap): ChartPlotZone {
  return {
    top: fvg.top,
    bottom: fvg.bottom,
    type: fvg.type,
    timeframe: fvg.timeframe,
    kind: "fvg",
    label: `${fvg.timeframe} ${fvg.type === "bullish" ? "Bull" : "Bear"} · ${fvg.respect}`,
    startTime: fvg.formedAt,
  };
}

export function rejectionToChartZone(
  block: {
    type: "bullish" | "bearish";
    top: number;
    bottom: number;
    formedAt: number;
  },
  timeframe: ChartPlotZone["timeframe"]
): ChartPlotZone {
  return {
    top: block.top,
    bottom: block.bottom,
    type: block.type,
    timeframe,
    kind: "rejection",
    label: `${timeframe} ${block.type === "bullish" ? "Bull" : "Bear"} RB`,
    startTime: block.formedAt,
  };
}

export function filterChartPlot(
  plot: SymbolChartPlot,
  overlays: ChartOverlaySettings
): SymbolChartPlot {
  return {
    lines: plot.lines.filter((line) => {
      if (line.role === "draw") return overlays.draw;
      if (line.role === "cisd") return overlays.cisd;
      if (line.role === "session") return overlays.session;
      if (line.role === "level") return overlays.levels;
      return false;
    }),
    zones: plot.zones.filter((zone) => {
      if (zone.kind === "fvg") return overlays.fvg;
      if (zone.kind === "rejection") return overlays.rejection;
      if (zone.kind === "draw-range") return overlays.draw;
      return true;
    }),
  };
}

export function fvgBoundaryLines(fvg: FairValueGap): ChartPlotLine[] {
  const kind = fvg.type === "bullish" ? "Bull" : "Bear";
  const color =
    fvg.type === "bullish"
      ? fvg.timeframe === "4H"
        ? "rgba(61, 214, 140, 0.7)"
        : "rgba(61, 214, 140, 0.5)"
      : fvg.timeframe === "4H"
        ? "rgba(242, 85, 90, 0.7)"
        : "rgba(242, 85, 90, 0.5)";

  return [
    {
      price: fvg.top,
      color,
      style: "dashed",
      label: `${fvg.timeframe} ${kind} FVG top`,
      role: "level",
    },
    {
      price: fvg.bottom,
      color,
      style: "dashed",
      label: `${fvg.timeframe} ${kind} FVG bot`,
      role: "level",
    },
  ];
}

function buildChartPlot(
  fvgs4h: FairValueGap[],
  fvgs1h: FairValueGap[],
  fvgBias: MarketBias,
  drawLevel: number,
  drawSide: "buy-side" | "sell-side",
  cisd: CisdLevel | null,
  h4High: number,
  h4Low: number,
  priorH4High: number,
  priorH4Low: number,
  current: number
): SymbolChartPlot {
  const zones: ChartPlotZone[] = [];
  const lines: ChartPlotLine[] = [
    {
      price: h4High,
      color: "rgba(61, 214, 140, 0.55)",
      style: "solid",
      label: "4H H",
      role: "level",
    },
    {
      price: h4Low,
      color: "rgba(242, 85, 90, 0.55)",
      style: "solid",
      label: "4H L",
      role: "level",
    },
  ];

  if (shouldShowDrawOnLiquidity(fvgBias)) {
    lines.push(drawPlotLine(drawSide, drawLevel));
  }

  if (Math.abs(priorH4High - h4High) >= 8) {
    lines.push({
      price: priorH4High,
      color: "rgba(122, 132, 148, 0.45)",
      style: "dashed",
      label: "Pr H",
      role: "level",
    });
  }
  if (Math.abs(priorH4Low - h4Low) >= 8) {
    lines.push({
      price: priorH4Low,
      color: "rgba(122, 132, 148, 0.45)",
      style: "dashed",
      label: "Pr L",
      role: "level",
    });
  }

  if (cisd) {
    lines.push({
      price: cisd.price,
      color:
        cisd.type === "bullish"
          ? "rgba(61, 214, 140, 0.75)"
          : "rgba(242, 85, 90, 0.75)",
      style: "solid",
      label: "CISD",
      role: "cisd",
    });
  }

  for (const fvg of relevantFvgsForChart(fvgs4h, current, 2)) {
    zones.push(fvgToChartZone(fvg));
  }
  for (const fvg of relevantFvgsForChart(fvgs1h, current, 2)) {
    zones.push(fvgToChartZone(fvg));
  }

  return { lines, zones };
}

export function analyzeSymbolMarket(
  candles: Candle[],
  h4High: number,
  h4Low: number,
  priorH4High: number,
  priorH4Low: number,
  current: number
): SymbolMarketAnalysis {
  const trimmed = trimFuturesCandleSeries(candles, current);
  const bars4h = aggregate4h(trimmed);
  const bars1h = aggregate1h(trimmed);

  const fvgs4h = detectFairValueGaps(bars4h, "4H");
  const fvgs1h = detectFairValueGaps(bars1h, "1H");
  const allFvgs = [...fvgs4h, ...fvgs1h];
  const fvgScore = scoreFvgBias(allFvgs);
  const fvgBias = deriveFvgBias(fvgScore);
  const cisd =
    detectCisd(bars1h, fvgs1h, "1H") ?? detectCisd(bars4h, fvgs4h, "4H");

  const swingHigh = nearestSwingHigh(bars4h);
  const swingLow = nearestSwingLow(bars4h);

  const { drawSide, drawLevel } = resolveDraw(
    fvgBias,
    swingHigh,
    swingLow,
    h4High,
    h4Low,
    current
  );

  const chartPlot = buildChartPlot(
    fvgs4h,
    fvgs1h,
    fvgBias,
    drawLevel,
    drawSide,
    cisd,
    h4High,
    h4Low,
    priorH4High,
    priorH4Low,
    current
  );

  return {
    fvgs4h,
    fvgs1h,
    fvgScore,
    fvgBias,
    fvgNarrative: fvgNarrative(fvgScore),
    cisd,
    drawLevel,
    drawSide,
    swingHigh,
    swingLow,
    chartPlot,
  };
}

export function keyLevelsFromAnalysis(
  label: "NQ" | "ES" | "GC",
  analysis: SymbolMarketAnalysis,
  current: number,
  h1High: number,
  h1Low: number
) {
  const levels: {
    symbol: "NQ" | "ES" | "GC";
    label: string;
    price: number;
    role: "draw" | "invalidation" | "intermediate" | "prior" | "fvg" | "cisd";
    pointsAway: number;
  }[] = [];

  if (shouldShowDrawOnLiquidity(analysis.fvgBias)) {
    levels.push({
      symbol: label,
      label: "Swing low · draw",
      price: analysis.drawLevel,
      role: "draw",
      pointsAway: Math.abs(current - analysis.drawLevel),
    });
  }

  for (const fvg of relevantFvgsForChart(analysis.fvgs4h, current, 2)) {
    levels.push({
      symbol: label,
      label: `${fvg.type === "bullish" ? "Bull" : "Bear"} 4H FVG (${fvg.respect})`,
      price: fvg.mid,
      role: "fvg",
      pointsAway: Math.abs(current - fvg.mid),
    });
  }

  for (const fvg of relevantFvgsForChart(analysis.fvgs1h, current, 2)) {
    levels.push({
      symbol: label,
      label: `${fvg.type === "bullish" ? "Bull" : "Bear"} 1H FVG (${fvg.respect})`,
      price: fvg.mid,
      role: "fvg",
      pointsAway: Math.abs(current - fvg.mid),
    });
  }

  if (analysis.cisd) {
    levels.push({
      symbol: label,
      label: `${analysis.cisd.type === "bullish" ? "Bull" : "Bear"} CISD`,
      price: analysis.cisd.price,
      role: "cisd",
      pointsAway: Math.abs(current - analysis.cisd.price),
    });
  }

  const use1h = Math.abs(current - h1High) <= Math.abs(current - h1Low);
  levels.push({
    symbol: label,
    label: use1h ? "1H intermediate high" : "1H intermediate low",
    price: use1h ? h1High : h1Low,
    role: "intermediate",
    pointsAway: Math.abs(current - (use1h ? h1High : h1Low)),
  });

  const seen = new Set<number>();
  const out: typeof levels = [];
  for (const lvl of levels) {
    const key = Math.round(lvl.price * 100);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(lvl);
    if (out.length >= 3) break;
  }
  return out;
}
