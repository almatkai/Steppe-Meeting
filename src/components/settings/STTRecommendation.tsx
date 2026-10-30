import type { STTModelRecommendation } from "../../types";

export function STTRecommendationLabels({ recommendation }: { recommendation?: STTModelRecommendation | null }) {
  if (!recommendation) return null;
  const { labels, use_case, use_case_caveat, note } = recommendation;
  return (
    <div className="mt-1 space-y-1">
      {(labels.length > 0 || use_case) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {labels.map((label) => (
            <span key={label} className="bg-neutral-100 text-neutral-950 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded whitespace-nowrap">{label}</span>
          ))}
          {use_case && <span className="border border-neutral-600 text-neutral-300 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded whitespace-nowrap">{use_case}</span>}
          {use_case_caveat && <span className="basis-full sm:basis-auto text-[10px] text-neutral-400">{use_case_caveat}</span>}
        </div>
      )}
      {note && <p className="text-[11px] text-neutral-300">{note}</p>}
    </div>
  );
}

export function STTRecommendationDetails({ recommendation }: { recommendation?: STTModelRecommendation | null }) {
  if (!recommendation) return null;
  return (
    <details onClick={(event) => event.stopPropagation()} className="mt-1 text-[11px] text-neutral-400">
      <summary className="min-h-7 py-1 w-fit cursor-pointer text-[10px] underline rounded focus-visible:outline focus-visible:outline-1 focus-visible:outline-neutral-300">Как определено</summary>
      <div className="space-y-1 pb-1">
        <p>{recommendation.result}</p>
        <p>{recommendation.basis}</p>
      </div>
    </details>
  );
}
