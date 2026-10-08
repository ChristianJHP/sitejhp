import { NextResponse } from "next/server";
import { biasSummaryCacheControl } from "@/lib/bias-summary-config";
import { withTimeout } from "@/lib/fetch-timeout";
import { isFuturesSessionOpen } from "@/lib/futures-session";
import {
  getCachedInstrumentBiasBrief,
  getDeterministicInstrumentBiasBrief,
  getFreshInstrumentBiasBrief,
} from "@/lib/instrument-bias-brief";
import type { SymbolLabel } from "@/lib/strategy-prep";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const VALID: SymbolLabel[] = ["NQ", "ES", "GC"];
/** Market context (≤18s) + AI (≤12s) + headroom; fallback still fits maxDuration. */
const CACHED_BRIEF_TIMEOUT_MS = 35_000;

function parseSymbol(raw: string | null): SymbolLabel | null {
  if (raw === "NQ" || raw === "ES" || raw === "GC") return raw;
  if (raw === "GOLD") return "GC";
  return null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const label = parseSymbol(url.searchParams.get("symbol")?.toUpperCase() ?? null);
  const fresh = url.searchParams.get("fresh") === "1";
  const reaction = url.searchParams.get("reaction")?.trim() || undefined;

  if (!label) {
    return NextResponse.json(
      { error: "symbol required (NQ, ES, GC)" },
      { status: 400 }
    );
  }

  const marketClosed = !isFuturesSessionOpen();

  if (fresh) {
    try {
      const payload = await withTimeout(
        getFreshInstrumentBiasBrief(label, reaction),
        20_000,
        "fresh instrument brief"
      );
      return NextResponse.json(payload, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      console.error("[bias/instrument-summary fresh]", error);
      try {
        const fallback = await getDeterministicInstrumentBiasBrief(label);
        return NextResponse.json(
          { ...fallback, stale: true },
          { headers: { "Cache-Control": "no-store" } }
        );
      } catch {
        /* fall through to cached path */
      }
    }
  }

  const cacheControl = biasSummaryCacheControl(marketClosed);

  try {
    const payload = await withTimeout(
      getCachedInstrumentBiasBrief(label),
      CACHED_BRIEF_TIMEOUT_MS,
      "cached instrument brief"
    );
    return NextResponse.json(payload, {
      headers: { "Cache-Control": cacheControl },
    });
  } catch (error) {
    console.error("[bias/instrument-summary]", error);
    try {
      const payload = await getDeterministicInstrumentBiasBrief(label);
      return NextResponse.json(
        { ...payload, stale: true },
        { headers: { "Cache-Control": "public, max-age=60" } }
      );
    } catch (inner) {
      console.error("[bias/instrument-summary deterministic]", inner);
      return NextResponse.json(
        {
          line: "Bias summary temporarily unavailable.",
          symbol: label,
          error: "unavailable",
        },
        { status: 503, headers: { "Cache-Control": "public, max-age=30" } }
      );
    }
  }
}
