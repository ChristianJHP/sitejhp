"use client";

import { useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import type { RadarTab } from "@/components/radar/MarketBoard";
import {
  detectSignificantMove,
  PRICE_REACTION_COOLDOWN_MS,
  prunePriceHistory,
  type PriceSample,
} from "@/lib/price-move-threshold";
import { formatLivePriceReaction } from "@/lib/live-reaction";
import type { LiveQuote } from "@/lib/yahoo-live-quote";
import type { InstrumentSummaryPayload } from "@/hooks/use-instrument-bias-summary";
import { CHART_TF_CONFIG } from "@/lib/chart-timeframe";
import { chartCandlesSwrKey } from "@/lib/chart-candles-cache";

const MAX_QUOTE_DELAY_SEC = 90;

const summaryFetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("summary refresh failed");
    return r.json() as Promise<InstrumentSummaryPayload>;
  });

/** On volatile moves: flash reaction, refresh bias, news, and chart candles. */
export function usePriceReactions(
  symbol: RadarTab,
  ticker: string,
  liveQuote: LiveQuote | null,
  active: boolean
) {
  const { mutate } = useSWRConfig();
  const [liveReaction, setLiveReaction] = useState<string | null>(null);
  const historyRef = useRef<PriceSample[]>([]);
  const lastReactionAtRef = useRef(0);

  useEffect(() => {
    if (!active || !liveQuote?.price || liveQuote.price <= 0) return;

    // Delayed feeds (Yahoo ~10m) jump in big steps — skip reaction spam.
    if ((liveQuote.delaySec ?? 0) > MAX_QUOTE_DELAY_SEC) return;

    const now = Date.now();
    historyRef.current = prunePriceHistory(
      [...historyRef.current, { t: now, price: liveQuote.price }],
      now
    );

    const move = detectSignificantMove(symbol, historyRef.current, now);
    if (!move) return;
    if (now - lastReactionAtRef.current < PRICE_REACTION_COOLDOWN_MS) return;

    lastReactionAtRef.current = now;
    const reaction = formatLivePriceReaction(symbol, move);
    setLiveReaction(reaction);

    const summaryKey = `/api/bias/instrument-summary?symbol=${symbol}`;
    const reactionParam = encodeURIComponent(reaction);

    // The fresh brief is rules-only. Never let it replace an AI trade map or
    // blank the panel on failure — just fold the reaction into the news line.
    void mutate<InstrumentSummaryPayload>(
      summaryKey,
      async (current) => {
        const fresh = await summaryFetcher(
          `${summaryKey}&fresh=1&reaction=${reactionParam}`
        ).catch(() => null);
        if (!fresh?.tradeMap) return current;
        if (current?.tradeMap && current.source === "ai") {
          return {
            ...current,
            tradeMap: { ...current.tradeMap, newsLine: fresh.tradeMap.newsLine },
          };
        }
        return fresh;
      },
      { revalidate: false }
    ).finally(() => {
      window.setTimeout(() => setLiveReaction(null), 12_000);
    });

    void mutate("/api/bias/geopolitics");

    for (const tf of ["1H", "5m"] as const) {
      const cfg = CHART_TF_CONFIG[tf];
      const chartKey = chartCandlesSwrKey(ticker, cfg.interval, cfg.range);
      void mutate(
        chartKey,
        fetch(`${chartKey}&fresh=1`)
          .then((r) => (r.ok ? r.json() : Promise.reject()))
          .catch(() => undefined),
        { revalidate: false }
      );
    }
  }, [active, liveQuote?.fetchedAt, liveQuote?.price, liveQuote?.delaySec, mutate, symbol, ticker]);

  return { liveReaction };
}
