"use client";

import { useMemo, useState } from "react";
import useSWR, { SWRConfig } from "swr";
import Link from "next/link";
import { getNextCandleClose } from "@/lib/candle-timers";
import { getTradingSessionInfo } from "@/lib/trading-session";
import type { RadarPayload } from "@/lib/radar-payload";
import { buildChartCandlesSwrFallback } from "@/lib/chart-candles-cache";
import { useCountdownTick } from "@/hooks/use-countdown-tick";
import { usePageVisible } from "@/hooks/use-page-visible";
import { useBiasShiftAlerts } from "@/hooks/use-bias-shift-alerts";
import { useCandleCloseAlerts } from "@/hooks/use-candle-close-alerts";
import { useAlertSettings } from "@/hooks/use-alert-settings";
import { useSeedChartCandles } from "@/hooks/use-seed-chart-candles";
import { BiasShiftToasts } from "@/components/radar/BiasShiftToasts";
import {
  AlertSettingsButton,
  AlertSettingsPanel,
} from "@/components/radar/AlertSettingsPanel";
import { CandleCloseToasts } from "@/components/radar/CandleCloseToasts";
import { RedFolderMoveToasts } from "@/components/radar/RedFolderMoveToasts";
import { MarketBoard } from "@/components/radar/MarketBoard";
import { useRedFolderMoveAlerts } from "@/hooks/use-red-folder-move-alerts";
import type { EconomicEvent } from "@/lib/events";
import { CandleTimerStrip } from "@/components/radar/CandleTimerStrip";
import { CalendarPanel } from "@/components/CalendarPanel";
import { RadarLoader } from "@/components/radar/RadarLoader";
import { anyAlertsEnabled } from "@/lib/alert-settings";

type RadarData = Pick<
  RadarPayload,
  "markets" | "chartCandles" | "redFolderWeek"
>;

type MarketRadarProps = {
  initialData?: RadarPayload | null;
};

function EtClock({ now }: { now: number }) {
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(now));

  return <time className="mr-clock" suppressHydrationWarning>{label}</time>;
}

export function MarketRadar({ initialData }: MarketRadarProps) {
  const [alertSettingsOpen, setAlertSettingsOpen] = useState(false);
  const now = useCountdownTick();
  const pageVisible = usePageVisible();

  const { data, isLoading } = useSWR<RadarData>(
    "/api/radar",
    (url: string) => fetch(url).then((r) => r.json()),
    {
      fallbackData: initialData ?? undefined,
      revalidateOnMount: true,
      refreshInterval: pageVisible ? 30_000 : 0,
      keepPreviousData: true,
      dedupingInterval: 15_000,
    }
  );

  const tradingSession = getTradingSessionInfo(new Date(now));
  const fifteenM = getNextCandleClose("15M", new Date(now));
  const oneH = getNextCandleClose("1H", new Date(now));
  const fourH = getNextCandleClose("4H", new Date(now));
  const ctx = data?.markets;

  useSeedChartCandles(data?.chartCandles);

  const {
    settings: alertSettings,
    notifyPermission,
    setBiasShifts,
    toggleCandleClose,
    setRedFolderMoves,
    setSoundEnabled,
    setBrowserNotifications,
    requestBrowserNotifications,
  } = useAlertSettings();

  const { alerts, dismissAlert } = useBiasShiftAlerts(ctx, alertSettings);
  const { alerts: candleCloseAlerts, dismissAlert: dismissCandleAlert } =
    useCandleCloseAlerts(now, alertSettings);

  const redFolderEvents: EconomicEvent[] =
    data?.redFolderWeek ?? initialData?.redFolderWeek ?? [];
  const { alerts: redFolderMoveAlerts, dismissAlert: dismissRedFolderMove } =
    useRedFolderMoveAlerts(redFolderEvents, alertSettings);

  const showLoader = !ctx && isLoading;

  const chartSwrFallback = useMemo(
    () =>
      buildChartCandlesSwrFallback(
        data?.chartCandles ?? initialData?.chartCandles
      ),
    [data?.chartCandles, initialData?.chartCandles]
  );

  return (
    <SWRConfig value={{ fallback: chartSwrFallback }}>
    <div className="mr-page">
      <BiasShiftToasts alerts={alerts} onDismiss={dismissAlert} />
      <CandleCloseToasts
        alerts={candleCloseAlerts}
        onDismiss={dismissCandleAlert}
      />
      <RedFolderMoveToasts
        alerts={redFolderMoveAlerts}
        onDismiss={dismissRedFolderMove}
      />
      <header className="mr-header">
        <div className="mr-header-main">
          <Link href="/" className="mr-back">
            jhptrades.com
          </Link>
          <div className="mr-header-row">
            <h1 className="mr-title">Market Bias</h1>
            <div className="mr-session-wrap">
              <div className="mr-session-live-row">
                {tradingSession.isMarketOpen ? (
                  <span className="live-pulse-dot" aria-hidden />
                ) : null}
                <span
                  suppressHydrationWarning
                  className={
                    tradingSession.isMarketOpen
                      ? "mr-session mr-session--open"
                      : "mr-session mr-session--closed"
                  }
                >
                  {tradingSession.label}
                </span>
              </div>
              <span className="mr-session-countdown" suppressHydrationWarning>
                {tradingSession.countdown}
              </span>
            </div>
          </div>
        </div>
        <div className="mr-header-actions">
          <div className="mr-header-notify-row">
            <div className="mr-header-calendar">
              <CalendarPanel initialRadar={initialData ?? undefined} />
            </div>
            <CandleTimerStrip
              fifteenMMs={fifteenM.remainingMs}
              oneHMs={oneH.remainingMs}
              fourHMs={fourH.remainingMs}
              candlesPaused={oneH.paused}
            />
            <AlertSettingsButton
              active={anyAlertsEnabled(alertSettings)}
              onClick={() => setAlertSettingsOpen(true)}
            />
            <AlertSettingsPanel
              open={alertSettingsOpen}
              onClose={() => setAlertSettingsOpen(false)}
              settings={alertSettings}
              notifyPermission={notifyPermission}
              onSetBiasShifts={setBiasShifts}
              onToggleCandleClose={toggleCandleClose}
              onSetRedFolderMoves={setRedFolderMoves}
              onSetSoundEnabled={setSoundEnabled}
              onSetBrowserNotifications={setBrowserNotifications}
              onRequestBrowserNotifications={() =>
                void requestBrowserNotifications()
              }
            />
          </div>
          <EtClock now={now} />
        </div>
      </header>

      {showLoader ? (
        <RadarLoader />
      ) : ctx ? (
        <div className="live-enter">
          <MarketBoard
            markets={ctx}
            chartCandles={data?.chartCandles}
          />
        </div>
      ) : (
        <p className="geo-strip-muted live-retry" style={{ padding: "1rem" }}>
          <span className="live-pulse-dot live-pulse-dot--muted" aria-hidden />
          Market data unavailable — retrying…
        </p>
      )}
    </div>
    </SWRConfig>
  );
}
