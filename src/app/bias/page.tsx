import { MarketRadar } from "@/components/radar/MarketRadar";
import { FeedbackBox } from "@/components/radar/FeedbackBox";
import { getRadarPayload } from "@/lib/radar-payload";

export const revalidate = 30;

export default async function BiasPage() {
  let initialData = null;
  try {
    initialData = await getRadarPayload();
  } catch {
    // Fall through — client will fetch via SWR
  }

  return (
    <main className="radar-shell">
      <MarketRadar initialData={initialData} />
      <FeedbackBox />
    </main>
  );
}
