import type { Candle } from "@/lib/chart-data";
import { trimFuturesCandleSeries } from "@/lib/futures-candle-trim";
import { aggregate1h, aggregate4h, type OhlcBar } from "@/lib/ohlc-aggregate";
import { candleSymbolBias, type SymbolContext } from "@/lib/htf-status";
import {
  drawPlotLine,
  fvgToChartZone,
  rejectionToChartZone,
  resolveDraw,
  shouldShowDrawOnLiquidity,
  type ChartPlotLine,
  type SymbolChartPlot,
} from "@/lib/market-analysis";
import { relevantFvgsForChart, type FairValueGap } from "@/lib/fvg-detect";
import {
  detectRejectionBlocks,
  relevantRejectionBlocksForChart,
} from "@/lib/rejection-block-detect";
import { sessionLinesForBars } from "@/lib/session-chart-lines";
import type { ChartOverlaySettings } from "@/lib/chart-overlay-types";
import type { ChartFocusLevels } from "@/lib/instrument-trade-map";
import { filterChartPlot } from "@/lib/market-analysis";

export type ChartTimeframe = "5m" | "15m" | "1H" | "4H";

export const CHART_TIMEFRAMES: ChartTimeframe[] = ["15m"];

type TfConfig = {
  interval: "5m" | "15m" | "60m";
  range: string;
  barCount: { mobile: number; desktop: number };
  /** Cap SWR refresh while futures are open (ms). */
  refreshCapMs?: number;
};

export const CHART_TF_CONFIG: Record<ChartTimeframe, TfConfig> = {
  "5m": {
    interval: "5m",
    range: "1mo",
    barCount: { mobile: 320, desktop: 600 },
    refreshCapMs: 45_000,
  },
  "15m": {
    interval: "15m",
    range: "1mo",
    barCount: { mobile: 160, desktop: 280 },
  },
  "1H": {
    interval: "60m",
    range: "1y",
    barCount: { mobile: 600, desktop: 2500 },
  },
  "4H": {
    interval: "60m",
    range: "1y",
    barCount: { mobile: 480, desktop: 1200 },
  },
};

export function candlesToBars(candles: Candle[]): OhlcBar[] {
  return candles.map((c) => ({
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    bucketKey: String(c.time),
    time: c.time,
  }));
}

export function barsForTimeframe(
  candles: Candle[],
  timeframe: ChartTimeframe,
  limit: number,
  anchorPrice?: number
): OhlcBar[] {
  let source = candles;
  if (timeframe === "1H" || timeframe === "4H") {
    source = trimFuturesCandleSeries(candles, anchorPrice);
  }

  let bars: OhlcBar[];
  if (timeframe === "4H") {
    bars = aggregate4h(source);
  } else if (timeframe === "1H") {
    bars = aggregate1h(source);
  } else {
    bars = candlesToBars(source);
  }
  return bars.slice(-limit);
}

/** Update the forming bar with a live quote so the chart matches the header price. */
export function patchFormingBar(
  bars: OhlcBar[],
  livePrice: number | undefined,
  liveMinuteBar?: {
    open: number;
    high: number;
    low: number;
    close: number;
  } | null
): OhlcBar[] {
  if (bars.length === 0) return bars;

  const last = bars[bars.length - 1]!;
  const close =
    livePrice && livePrice > 0
      ? livePrice
      : liveMinuteBar?.close && liveMinuteBar.close > 0
        ? liveMinuteBar.close
        : undefined;

  if (liveMinuteBar && close) {
    return [
      ...bars.slice(0, -1),
      {
        ...last,
        close,
        high: Math.max(last.high, liveMinuteBar.high, close),
        low: Math.min(last.low, liveMinuteBar.low, close),
      },
    ];
  }

  if (!close) return bars;

  const maxPatch = Math.max(last.close * 0.025, last.close > 2000 ? 140 : 24);
  if (Math.abs(close - last.close) > maxPatch) return bars;

  return [
    ...bars.slice(0, -1),
    {
      ...last,
      close,
      high: Math.max(last.high, close),
      low: Math.min(last.low, close),
    },
  ];
}

export type PlottedFvg = {
  timeframe: "4H" | "1H";
  fvg: FairValueGap;
};

function plotTimeframeForChart(chartTf: ChartTimeframe): "4H" | "1H" {
  return chartTf === "4H" ? "4H" : "1H";
}

function fvgLimit(chartTf: ChartTimeframe): number {
  return 2;
}

export function plottedFvgsForTimeframe(
  symbol: SymbolContext,
  chartTf: ChartTimeframe
): PlottedFvg[] {
  const plotTf = plotTimeframeForChart(chartTf);
  const current = symbol.current;
  const pool =
    plotTf === "4H" ? symbol.analysis.fvgs4h : symbol.analysis.fvgs1h;

  const picked = relevantFvgsForChart(
    pool,
    current,
    fvgLimit(chartTf),
    symbol.label
  );
  return picked.map((fvg) => ({ timeframe: plotTf, fvg }));
}

function buildFvgPlot(
  symbol: SymbolContext,
  chartTf: ChartTimeframe
): { lines: ChartPlotLine[]; zones: SymbolChartPlot["zones"] } {
  const plotted = plottedFvgsForTimeframe(symbol, chartTf);
  const lines: ChartPlotLine[] = [];
  const zones: SymbolChartPlot["zones"] = [];

  for (const { fvg } of plotted) {
    zones.push(fvgToChartZone(fvg));
  }

  return { lines, zones };
}

export function plotForTimeframe(
  symbol: SymbolContext,
  timeframe: ChartTimeframe
): SymbolChartPlot {
  const bias = candleSymbolBias(symbol);
  const { drawSide, drawLevel } = resolveDraw(
    bias,
    symbol.analysis.swingHigh,
    symbol.analysis.swingLow,
    symbol.h4High,
    symbol.h4Low,
    symbol.current
  );

  const { zones: fvgZones } = buildFvgPlot(symbol, timeframe);
  const lines: ChartPlotLine[] = [];
  const zones = [...fvgZones];

  if (shouldShowDrawOnLiquidity(bias)) {
    lines.push(drawPlotLine(drawSide, drawLevel));

    const rangeTop = Math.max(symbol.current, drawLevel);
    const rangeBottom = Math.min(symbol.current, drawLevel);
    // startTime far enough back to span the whole 15m chart window (1mo)
    const rangeStart = Math.floor(Date.now() / 1000) - 86400 * 32;
    zones.push({
      top: rangeTop,
      bottom: rangeBottom,
      type: drawSide === "buy-side" ? "bullish" : "bearish",
      timeframe: "1H",
      kind: "draw-range",
      label: drawSide === "buy-side" ? "Draw range ↑" : "Draw range ↓",
      startTime: rangeStart,
    });
  }

  return { lines, zones };
}

/** Only the 2–3 levels that matter for the trade map — no ICT Christmas lights. */
export function plotFocusFromTradeMap(
  symbol: SymbolContext,
  focus: ChartFocusLevels,
  timeframe: ChartTimeframe
): SymbolChartPlot {
  const lines: ChartPlotLine[] = [];
  const zones: SymbolChartPlot["zones"] = [];
  const zoneStart = Math.floor(Date.now() / 1000) - 86400 * 4;
  const tf = timeframe === "4H" ? "4H" : "1H";

  if (focus.drawLevel != null && focus.drawSide) {
    const drawLine = drawPlotLine(focus.drawSide, focus.drawLevel);
    drawLine.label = focus.drawSide === "sell-side" ? "Draw ↓" : "Draw ↑";
    lines.push(drawLine);
  }

  if (focus.keyLevelLow != null && focus.keyLevelHigh != null) {
    const low = Math.min(focus.keyLevelLow, focus.keyLevelHigh);
    const high = Math.max(focus.keyLevelLow, focus.keyLevelHigh);
    const minSpan = symbol.label === "GC" ? 0.25 : 2;
    if (high - low >= minSpan) {
      zones.push({
        top: high,
        bottom: low,
        type: "bearish",
        timeframe: tf,
        kind: "fvg",
        label: "Reclaim zone",
        startTime: zoneStart,
      });
    } else {
      lines.push({
        price: high,
        color: "rgba(148, 163, 184, 0.65)",
        style: "dashed",
        label: "Key level",
        role: "level",
      });
    }
  }

  if (focus.invalidationLevel != null) {
    lines.push({
      price: focus.invalidationLevel,
      color: "rgba(242, 85, 90, 0.55)",
      style: "dashed",
      label: "Invalidation",
      role: "level",
    });
  }

  return { lines, zones };
}

function plotPriceKey(line: ChartPlotLine): string {
  return `${line.role}-${Math.round(line.price * 100)}`;
}

/** Minimal focus plot + optional overlay expansion. */
export function buildChartPlot(
  symbol: SymbolContext,
  timeframe: ChartTimeframe,
  focus: ChartFocusLevels | undefined,
  overlays: ChartOverlaySettings
): SymbolChartPlot {
  const extended = plotForTimeframe(symbol, timeframe);
  const base = focus
    ? plotFocusFromTradeMap(symbol, focus, timeframe)
    : extended;

  const extras = filterChartPlot(extended, overlays);
  const lineKeys = new Set(base.lines.map(plotPriceKey));
  const lines = [...base.lines];

  for (const line of extras.lines) {
    const key = plotPriceKey(line);
    if (lineKeys.has(key)) continue;
    if (line.role === "draw" && !overlays.draw) continue;
    if (line.role === "level" && !overlays.levels) continue;
    if (line.role === "cisd" && !overlays.cisd) continue;
    if (line.role === "session" && !overlays.session) continue;
    lineKeys.add(key);
    lines.push(line);
  }

  const zoneKeys = new Set(
    base.zones.map((z) => `${z.kind}-${Math.round(z.bottom * 100)}`)
  );
  const zones = [...base.zones];
  for (const zone of extras.zones) {
    const key = `${zone.kind}-${Math.round(zone.bottom * 100)}`;
    if (zoneKeys.has(key)) continue;
    if (zone.kind === "fvg" && !overlays.fvg) continue;
    if (zone.kind === "rejection" && !overlays.rejection) continue;
    zoneKeys.add(key);
    zones.push(zone);
  }

  return { lines, zones };
}

/** RB scan window — only recent structure matters for overlay picks. */
const RB_DETECT_MAX_BARS = 480;

export function rejectionZonesForBars(
  bars: OhlcBar[],
  chartTf: ChartTimeframe,
  current: number,
  max = 2,
  symbolLabel?: string
): SymbolChartPlot["zones"] {
  if (!bars.length || current <= 0) return [];
  const scanBars =
    bars.length > RB_DETECT_MAX_BARS
      ? bars.slice(-RB_DETECT_MAX_BARS)
      : bars;
  const blocks = detectRejectionBlocks(scanBars);
  const picked = relevantRejectionBlocksForChart(
    blocks,
    current,
    max,
    symbolLabel
  );
  return picked.map((block) => rejectionToChartZone(block, chartTf));
}

export { sessionLinesForBars } from "@/lib/session-chart-lines";

/** Empty bar slots after the forming candle so it isn't flush against the price scale. */
export const CHART_RIGHT_OFFSET = 3;

/** Default bars in view on load / reset — leaves history to pan into. */
export const CHART_DEFAULT_VISIBLE_BARS = { mobile: 56, desktop: 80 };

export function defaultVisibleLogicalRange(
  barCount: number,
  isMobile: boolean
): { from: number; to: number } {
  const target = isMobile
    ? CHART_DEFAULT_VISIBLE_BARS.mobile
    : CHART_DEFAULT_VISIBLE_BARS.desktop;
  const shown = Math.min(barCount, target);
  return {
    from: Math.max(-0.5, barCount - shown - 0.5),
    to: barCount - 0.5,
  };
}

export function fitBarSpacing(
  containerWidth: number,
  barCount: number,
  isMobile: boolean
): number {
  const scaleW = isMobile ? 44 : 52;
  const plotW = Math.max(120, containerWidth - scaleW - 8);
  const slots = Math.max(barCount, 1) + CHART_RIGHT_OFFSET;
  return Math.max(3, plotW / slots);
}

/** Fill the plot width with a recent window of bars (pan/zoom reveals the rest). */
export function fitChartTimeScale(
  chart: {
    applyOptions: (opts: {
      timeScale: {
        barSpacing: number;
        minBarSpacing: number;
        maxBarSpacing: number;
        rightOffset: number;
      };
    }) => void;
    timeScale: () => {
      setVisibleLogicalRange: (range: { from: number; to: number }) => void;
    };
  },
  containerWidth: number,
  barCount: number,
  isMobile: boolean
): void {
  if (barCount <= 0 || containerWidth <= 0) return;

  const range = defaultVisibleLogicalRange(barCount, isMobile);
  const visibleBars = Math.max(1, Math.ceil(range.to - range.from));
  const spacing = fitBarSpacing(containerWidth, visibleBars, isMobile);

  chart.applyOptions({
    timeScale: {
      barSpacing: spacing,
      minBarSpacing: 2,
      maxBarSpacing: 48,
      rightOffset: CHART_RIGHT_OFFSET,
    },
  });

  chart.timeScale().setVisibleLogicalRange(range);
}

/** Recompute bar width after resize without resetting scroll/zoom. */
export function updateChartBarSpacing(
  chart: {
    applyOptions: (opts: {
      timeScale: {
        barSpacing: number;
        minBarSpacing: number;
        maxBarSpacing: number;
      };
    }) => void;
  },
  containerWidth: number,
  barCount: number,
  isMobile: boolean
): void {
  if (barCount <= 0 || containerWidth <= 0) return;

  const spacing = fitBarSpacing(containerWidth, barCount, isMobile);

  chart.applyOptions({
    timeScale: {
      barSpacing: spacing,
      minBarSpacing: 2,
      maxBarSpacing: 48,
    },
  });
}
