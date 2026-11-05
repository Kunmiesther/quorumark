import { useCallback, useEffect, useRef, useState } from "react";
import { Delete } from "lucide-react";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"] as const;

export function PinKeypad({
  onDigit,
  onDelete,
}: {
  onDigit: (d: string) => void;
  onDelete: () => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((key: string) => {
    setActive(key);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setActive(null), 150);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (/^[0-9]$/.test(event.key)) { flash(event.key); onDigit(event.key); }
      if (event.key === "Backspace" || event.key === "Delete") { flash("del"); onDelete(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flash, onDelete, onDigit]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <div className="mx-auto grid w-full max-w-xs grid-cols-3 gap-3">
      {KEYS.map((k, i) => {
        if (k === "") return <div key={i} />;
        if (k === "del") {
          return (
            <button
              key={i}
              onClick={() => { flash("del"); onDelete(); }}
              aria-label="Delete"
              className={`pin-key flex h-16 items-center justify-center rounded-2xl text-muted-foreground ${active === "del" ? "pin-key-active" : ""}`}
            >
              <Delete className="h-5 w-5" />
            </button>
          );
        }
        return (
          <button
            key={i}
            onClick={() => { flash(k); onDigit(k); }}
            className={`pin-key welcome-neo-button flex h-16 items-center justify-center rounded-2xl text-2xl font-display font-semibold text-foreground ${active === k ? "pin-key-active" : ""}`}
          >
            {k}
          </button>
        );
      })}
    </div>
  );
}
