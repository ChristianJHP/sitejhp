"use client";

import useSWR from "swr";
import { formatCountdownHuman } from "@/lib/candle-timers";
import type { EconomicEvent } from "@/lib/events";
import { useCountdownTick } from "@/hooks/use-countdown-tick";

const TZ = "America/New_York";
const MS_24H = 24 * 60 * 60 * 1000;

import type { RadarPayload } from "@/lib/radar-payload";

type CalendarPanelProps = {
  initialRadar?: RadarPayload | null;
};

function dayKeyEt(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function isTodayEt(iso: string, now: Date): boolean {
  return dayKeyEt(new Date(iso)) === dayKeyEt(now);
}

function upcomingEvents(events: EconomicEvent[], now: number): EconomicEvent[] {
  return events
    .filter((e) => new Date(e.scheduledAt).getTime() > now)
    .sort(
      (a, b) =>
        new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
    );
}

export function CalendarPanel({ initialRadar }: CalendarPanelProps) {
  const now = useCountdownTick();
  const { data, isLoading, error } = useSWR<Pick<RadarPayload, "redFolderWeek">>(
    "/api/radar",
    (url: string) => fetch(url).then((r) => r.json()),
    {
      fallbackData: initialRadar ?? undefined,
      revalidateOnMount: !initialRadar?.redFolderWeek?.length,
      refreshInterval: 120_000,
    }
  );

  const events = data?.redFolderWeek ?? [];
  const ts = now;
  const upcoming = upcomingEvents(events, ts);
  const next = upcoming[0];

  if (isLoading && events.length === 0) {
    return <p className="calendar-compact calendar-compact--muted">Loading…</p>;
  }

  if (error && events.length === 0) {
    return (
      <p className="calendar-compact calendar-compact--muted">Unavailable</p>
    );
  }

  if (!next) {
    return (
      <p className="calendar-compact calendar-compact--muted">No tier-1 events</p>
    );
  }

  const ms = new Date(next.scheduledAt).getTime() - ts;
  const today = isTodayEt(next.scheduledAt, new Date(ts));

  if (!today && ms > MS_24H) {
    return (
      <div className="calendar-compact">
        <span className="calendar-compact-k">Next red folder</span>
        <span className="calendar-compact-v" suppressHydrationWarning>
          {next.title} · {formatCountdownHuman(ms)}
        </span>
      </div>
    );
  }

  const show = today
    ? upcoming.filter((e) => isTodayEt(e.scheduledAt, new Date(ts)))
    : upcoming.slice(0, 3);

  return (
    <ul
      className="calendar-list calendar-list--dense"
      aria-label={today ? "Red folder today" : "Upcoming red folder"}
    >
      {show.map((e) => {
        const eventMs = new Date(e.scheduledAt).getTime() - ts;
        return (
          <li key={`${e.title}-${e.scheduledAt}`} className="calendar-row">
            <span className="calendar-row-title">{e.title}</span>
            <span className="calendar-row-meta" suppressHydrationWarning>
              {formatCountdownHuman(eventMs)} · {e.timeEt} ET
            </span>
          </li>
        );
      })}
    </ul>
  );
}
