"use client";

import { useCountdownTick } from "@/hooks/use-countdown-tick";
import { BIAS_SUMMARY_REVALIDATE_SEC } from "@/lib/bias-summary-config";
import { BiasSummarySkeleton } from "@/components/radar/LiveSkeleton";
import type { InstrumentSummaryPayload } from "@/hooks/use-instrument-bias-summary";
import type { RadarTab } from "@/components/radar/MarketBoard";
import type { VolatilityRegime } from "@/lib/session-volatility";

function revalidateMs(data: InstrumentSummaryPayload | undefined): number {
  return (data?.revalidateSec ?? BIAS_SUMMARY_REVALIDATE_SEC) * 1000;
}

function formatTimeEt(iso: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function formatRefreshMeta(
  generatedAt: string | undefined,
  now: number,
  revalidateMsValue: number
) {
  if (!generatedAt) return null;
  const generatedMs = new Date(generatedAt).getTime();
  if (Number.isNaN(generatedMs)) return null;

  const nextMs = generatedMs + revalidateMsValue;
  const at = formatTimeEt(generatedAt);

  if (now >= nextMs) return `${at} ET · updating…`;

  const minsUntil = Math.max(1, Math.ceil((nextMs - now) / 60_000));
  return `${at} ET · refresh ${minsUntil}m`;
}

const SYMBOL_LABEL: Record<RadarTab, string> = {
  NQ: "NQ",
  ES: "ES",
  GC: "Gold",
};

const VOL_LABEL: Record<VolatilityRegime, string> = {
  calm: "Calm",
  elevated: "Elevated",
  high: "High",
};

function biasClass(bias: string): string {
  if (bias === "bullish") return "trade-map-val--bull";
  if (bias === "bearish") return "trade-map-val--bear";
  return "trade-map-val--mixed";
}

type InstrumentBiasSummaryProps = {
  symbol: RadarTab;
  data?: InstrumentSummaryPayload;
  isLoading?: boolean;
  isValidating?: boolean;
  liveReaction?: string | null;
};

export function InstrumentBiasSummary({
  symbol,
  data,
  isLoading = false,
  isValidating = false,
  liveReaction = null,
}: InstrumentBiasSummaryProps) {
  const now = useCountdownTick(30_000);
  const map = data?.tradeMap;

  const refreshMeta = formatRefreshMeta(
    data?.generatedAt,
    now ?? Date.now(),
    revalidateMs(data)
  );

  const isRefreshing = isValidating && Boolean(map?.headline);

  return (
    <section
      className={`bias-summary bias-summary--embedded bias-summary--trade-map live-enter${
        isRefreshing ? " bias-summary--refreshing" : ""
      }`}
      aria-live="polite"
    >
      <header className="bias-summary-head">
        <span className="bias-summary-label">
          {data?.marketOpen === false ? "When open" : "Trade map"} ·{" "}
          {SYMBOL_LABEL[symbol]}
        </span>
        {refreshMeta ? (
          <span className="bias-summary-timing">{refreshMeta}</span>
        ) : null}
      </header>

      {liveReaction ? (
        <p className="trade-map-live-reaction live-stagger-in" role="status">
          <span className="live-pulse-dot" aria-hidden />
          {liveReaction}
        </p>
      ) : null}

      {isLoading && !map?.headline ? (
        <BiasSummarySkeleton />
      ) : map?.headline ? (
        <div className="trade-map live-text-in" key={map.headline.slice(0, 20)}>
          <p className="trade-map-headline">{map.headline}</p>
          <p className="trade-map-context">{map.context}</p>
          {map.volatilityNote ? (
            <p
              className={`trade-map-vol trade-map-vol--${map.volatility ?? "calm"}`}
            >
              <span className="trade-map-vol-tag">
                Session vol · {VOL_LABEL[map.volatility ?? "calm"]}
              </span>
              {map.volatilityNote}
            </p>
          ) : null}

          <dl className="trade-map-grid">
            <div className="trade-map-item">
              <dt>Bias</dt>
              <dd className={biasClass(map.bias)}>
                {map.bias.charAt(0).toUpperCase() + map.bias.slice(1)}
              </dd>
            </div>
            <div className="trade-map-item">
              <dt>Key level</dt>
              <dd>{map.keyLevel}</dd>
            </div>
            <div className="trade-map-item">
              <dt>Draw</dt>
              <dd>{map.draw}</dd>
            </div>
            <div className="trade-map-item">
              <dt>Invalidation</dt>
              <dd>{map.invalidation}</dd>
            </div>
            <div className="trade-map-item">
              <dt>Confidence</dt>
              <dd>{map.confidence}</dd>
            </div>
          </dl>
        </div>
      ) : (
        <p className="bias-summary-text bias-summary-text--muted">
          Summary unavailable.
        </p>
      )}
    </section>
  );
}
