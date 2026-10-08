"use client";

import { useMemo, useState } from "react";
import {
  filterNewsForInstrument,
  instrumentNewsSubtitle,
  topCatalystForInstrument,
  type InstrumentNewsLabel,
} from "@/lib/instrument-news";
import { NewsFeedSkeleton } from "@/components/radar/LiveSkeleton";
import { useGeopoliticsFeed } from "@/hooks/use-geopolitics-feed";
import { mergeReactionIntoNewsLine } from "@/lib/live-reaction";

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function labelClass(label: string): string {
  switch (label) {
    case "MUST KNOW":
      return "news-feed-tag--must-know";
    case "HIGH IMPACT":
      return "news-feed-tag--high-impact";
    case "GEO":
      return "news-feed-tag--geo";
    case "MACRO":
      return "news-feed-tag--macro";
    case "EARNINGS":
      return "news-feed-tag--earnings";
    case "DATA":
      return "news-feed-tag--data";
    default:
      return "news-feed-tag--watch";
  }
}

type MarketNewsFeedProps = {
  instrument: InstrumentNewsLabel;
  newsImpact?: string;
  newsLine?: string;
  liveReaction?: string | null;
};

export function MarketNewsFeed({
  instrument,
  newsImpact,
  newsLine,
  liveReaction = null,
}: MarketNewsFeedProps) {
  const [expanded, setExpanded] = useState(true);
  const { feed: rawFeed, isLoading } = useGeopoliticsFeed();

  const feed = useMemo(
    () => filterNewsForInstrument(rawFeed, instrument, 10),
    [rawFeed, instrument]
  );

  const feedCatalyst = useMemo(
    () => topCatalystForInstrument(rawFeed, instrument),
    [rawFeed, instrument]
  );

  if (isLoading && feed.length === 0) {
    return <NewsFeedSkeleton rows={2} />;
  }

  const impact = newsImpact ?? "Mixed";
  const baseCatalyst =
    newsLine ?? feedCatalyst ?? "No catalyst summary available.";
  const catalyst = liveReaction
    ? mergeReactionIntoNewsLine(baseCatalyst, liveReaction)
    : baseCatalyst;

  const preview = feed.slice(0, 3);
  const rest = feed.slice(3);

  return (
    <section className="news-feed news-feed--compact live-enter" aria-label="Market news">
      <header className="news-feed-head">
        <h2 className="news-feed-title">News</h2>
        <span className="news-feed-sub">{instrumentNewsSubtitle(instrument)}</span>
      </header>

      <div className="news-catalyst">
        <p className="news-catalyst-impact">
          <span className="news-catalyst-k">News impact</span>
          {impact}
        </p>
        <p className="news-catalyst-line">{catalyst}</p>
      </div>

      {feed.length === 0 ? (
        <p className="news-feed-muted">
          Headlines unavailable — RSS may be blocked. Retry in a minute.
        </p>
      ) : (
        <>
          <ul className="news-feed-list news-feed-list--secondary">
            {(expanded ? feed : preview).map((item, i) => (
              <li
                key={item.id}
                className="news-feed-row live-stagger-in"
                style={{ animationDelay: `${i * 0.04}s` }}
              >
                <div className="news-feed-tags">
                  <span className={`news-feed-tag ${labelClass(item.label)}`}>
                    {item.label}
                  </span>
                  {item.topics
                    .filter((topic) => topic.toUpperCase() !== item.label)
                    .map((topic) => (
                      <span key={topic} className="news-feed-topic">
                        {topic}
                      </span>
                    ))}
                </div>
                {item.link ? (
                  <a
                    href={item.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="news-feed-text"
                  >
                    {item.text}
                  </a>
                ) : (
                  <p className="news-feed-text">{item.text}</p>
                )}
                <time className="news-feed-time" dateTime={item.publishedAt}>
                  {formatTime(item.publishedAt)}
                </time>
              </li>
            ))}
          </ul>

          {rest.length > 0 ? (
            <button
              type="button"
              className="news-feed-more news-feed-more--top"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
            >
              {expanded ? "Show fewer headlines" : `Show ${feed.length} headlines`}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
