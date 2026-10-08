import {
  fetchCalendarMeta,
  pickNextHighImpact,
  type EconomicEvent,
} from "@/lib/events";
import {
  computeMarketContextFromCharts,
  type MarketContext,
} from "@/lib/htf-status";
import {
  loadAllChartCandles,
  type ChartCandlesPayload,
} from "@/lib/chart-candles-cache";

export type RadarPayload = {
  markets: MarketContext | null;
  nextHighImpact: EconomicEvent | null;
  redFolderWeek: EconomicEvent[];
  calendarSource: string | null;
  chartCandles: Record<string, ChartCandlesPayload>;
};

export async function getRadarPayload(): Promise<RadarPayload> {
  // Start calendar fetch immediately — it's independent of chart data
  const calPromise = fetchCalendarMeta();

  const chartCandles = await loadAllChartCandles();

  const [marketsResult, calResult] = await Promise.allSettled([
    computeMarketContextFromCharts(chartCandles),
    calPromise,
  ]);

  const markets =
    marketsResult.status === "fulfilled" ? marketsResult.value : null;
  if (marketsResult.status === "rejected") {
    console.error("[radar] markets", marketsResult.reason);
  }

  let redFolderWeek: EconomicEvent[] = [];
  let calendarSource: string | null = null;
  if (calResult.status === "fulfilled") {
    redFolderWeek = calResult.value.events;
    calendarSource = calResult.value.source;
  } else {
    console.error("[radar] calendar", calResult.reason);
  }

  return {
    markets,
    nextHighImpact: pickNextHighImpact(redFolderWeek),
    redFolderWeek,
    calendarSource,
    chartCandles,
  };
}
