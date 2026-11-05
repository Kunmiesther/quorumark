export function PinSuccess() {
  return (
    <div role="status" aria-live="polite" className="flex min-h-[calc(100dvh-2rem)] flex-1 items-center justify-center py-10 text-center">
      <div className="pin-success-card w-full max-w-[330px] rounded-[30px] px-6 py-12">
        <div className="pin-success-orb relative mx-auto flex h-28 w-28 items-center justify-center rounded-full">
          <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full -rotate-90">
            <circle cx="50" cy="50" r="44" fill="none" stroke="rgba(255,255,255,.07)" strokeWidth="4" />
            <circle className="pin-success-ring" cx="50" cy="50" r="44" fill="none" stroke="rgb(168 85 247)" strokeWidth="4" strokeLinecap="round" />
          </svg>
          <svg viewBox="0 0 48 48" className="relative h-12 w-12 text-purple-400">
            <path className="pin-success-check" d="M13 25.5 21 33 35 16" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h1 className="mt-8 font-display text-[25px] font-bold text-white">PIN Confirmed</h1>
        <p className="mt-3 text-sm leading-relaxed text-purple-200/65">Your app PIN is ready.<br />You can now enable Face ID.</p>
      </div>
    </div>
  );
}
