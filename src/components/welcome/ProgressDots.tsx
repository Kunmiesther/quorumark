export function ProgressDots({ step, total = 4 }: { step: number; total?: number }) {
  const progress = Math.min(100, Math.max(8, ((step + 1) / total) * 100));
  return (
    <div className="welcome-progress mx-auto w-full max-w-[330px]" aria-label={`Onboarding step ${step + 1} of ${total}`}>
      <div className="mb-2 flex items-center justify-between px-1 text-[9px] font-semibold uppercase tracking-[.22em] text-purple-200/55"><span>Setup progress</span><span>{Math.round(progress)}%</span></div>
      <div className="welcome-progress-track relative h-2 overflow-visible rounded-full">
        <span className="welcome-progress-fill absolute inset-y-0 left-0 rounded-full" style={{ width: `${progress}%` }}><span className="welcome-progress-pulse absolute right-0 top-1/2 h-3 w-3 -translate-y-1/2 translate-x-1/2 rounded-full" /></span>
      </div>
    </div>
  );
}
