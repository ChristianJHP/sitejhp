import { isFuturesSessionOpen } from "@/lib/futures-session";

/** Yahoo candle refresh while futures are open (seconds). */
export const CHART_CANDLES_REVALIDATE_OPEN_SEC = 30;

/** Longer cache when futures are closed. */
export const CHART_CANDLES_REVALIDATE_CLOSED_SEC = 5 * 60;

export function getChartCandlesRevalidateSec(): number {
  return isFuturesSessionOpen()
    ? CHART_CANDLES_REVALIDATE_OPEN_SEC
    : CHART_CANDLES_REVALIDATE_CLOSED_SEC;
}

export function chartCandlesCacheControl(marketClosed?: boolean): string {
  const closed = marketClosed ?? !isFuturesSessionOpen();
  const sec = closed
    ? CHART_CANDLES_REVALIDATE_CLOSED_SEC
    : CHART_CANDLES_REVALIDATE_OPEN_SEC;
  return `public, s-maxage=${sec}, max-age=${sec}, stale-while-revalidate=3600`;
}
