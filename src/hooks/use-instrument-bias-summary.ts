"use client";

import { useEffect, useMemo } from "react";
import useSWR from "swr";
import { BIAS_SUMMARY_REVALIDATE_SEC } from "@/lib/bias-summary-config";
import type { ChartOverlaySettings } from "@/lib/chart-overlay-types";
import type { InstrumentTradeMap } from "@/lib/instrument-trade-map";
import type { RadarTab } from "@/components/radar/MarketBoard";

const DEFAULT_REVALIDATE_MS = BIAS_SUMMARY_REVALIDATE_SEC * 1000;

export type InstrumentSummaryPayload = {
  line: string | null;
  symbol?: string;
  generatedAt?: string;
  configured?: boolean;
  marketOpen?: boolean;
  revalidateSec?: number;
  overlays?: ChartOverlaySettings;
  tradeMap?: InstrumentTradeMap;
  /** "ai" when the AI refined the map; "fallback" for the rules-based draft. */
  source?: "ai" | "fallback";
  fallbackReason?: string;
};

type StoredSummary = {
  fetchedAt: number;
  revalidateSec: number;
  data: InstrumentSummaryPayload;
};

function storageKey(symbol: RadarTab) {
  return `jhp-instrument-bias-v3-${symbol}`;
}

function readStoredSummary(symbol: RadarTab): InstrumentSummaryPayload | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = localStorage.getItem(storageKey(symbol));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as StoredSummary;
    const ttl = parsed.revalidateSec * 1000;
    if (Date.now() - parsed.fetchedAt > ttl) return undefined;
    return parsed.data;
  } catch {
    return undefined;
  }
}

function writeStoredSummary(symbol: RadarTab, data: InstrumentSummaryPayload) {
  if (typeof window === "undefined" || !data.tradeMap?.headline) return;
  try {
    localStorage.setItem(
      storageKey(symbol),
      JSON.stringify({
        fetchedAt: Date.now(),
        revalidateSec: data.revalidateSec ?? BIAS_SUMMARY_REVALIDATE_SEC,
        data,
      })
    );
  } catch {
    /* ignore */
  }
}

export function useInstrumentBiasSummary(symbol: RadarTab) {
  const stored = useMemo(() => readStoredSummary(symbol), [symbol]);

  const swr = useSWR<InstrumentSummaryPayload>(
    `/api/bias/instrument-summary?symbol=${symbol}`,
    (url: string) =>
      fetch(url).then((r) => {
        if (!r.ok) throw new Error("instrument summary failed");
        return r.json();
      }),
    {
      fallbackData: stored,
      refreshInterval: (latest) =>
        latest?.revalidateSec
          ? latest.revalidateSec * 1000
          : DEFAULT_REVALIDATE_MS,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 60_000,
      keepPreviousData: true,
      errorRetryCount: 3,
      errorRetryInterval: 5_000,
    }
  );

  useEffect(() => {
    if (swr.data?.tradeMap?.headline) writeStoredSummary(symbol, swr.data);
  }, [swr.data, symbol]);

  return swr;
}
