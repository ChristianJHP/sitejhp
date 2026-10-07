export type ChartOverlayKey =
  | "draw"
  | "fvg"
  | "rejection"
  | "cisd"
  | "session"
  | "levels";

export type ChartOverlaySettings = Record<ChartOverlayKey, boolean>;

export const CHART_OVERLAY_LABELS: Record<
  ChartOverlayKey,
  { label: string; short: string }
> = {
  draw: { label: "Draw on liquidity", short: "Draw" },
  fvg: { label: "Fair value gaps", short: "FVG" },
  rejection: { label: "Rejection blocks", short: "Rejection" },
  cisd: { label: "CISD level", short: "CISD" },
  session: { label: "Current session high & low", short: "Session" },
  levels: { label: "4H / prior highs & lows", short: "Levels" },
};

export const DEFAULT_CHART_OVERLAYS: ChartOverlaySettings = {
  draw: true,
  fvg: false,
  rejection: false,
  cisd: false,
  session: false,
  levels: true,
};
