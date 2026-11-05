import { FormEvent, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUp, Check, ChevronRight, Circle, Loader2, Sparkles } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  askOnyxSetupGuide,
  getOnyxSetupGuide,
  type SetupStep,
} from "@/lib/onyx/setup-guide.functions";
import { beginOnyxThinking, endOnyxThinking } from "@/components/onyx/OnyxBeacon";

type ConversationItem = { role: "user" | "assistant"; content: string };

const SUGGESTIONS = [
  "What is the best available setup right now?",
  "What do I need before I can trade?",
  "Help me practice safely",
  "Explain my setup",
  "How does Autopilot protect my goal?",
] as const;

function stepTone(step: SetupStep) {
  if (step.complete) return "text-emerald-300";
  if (step.required) return "text-amber-300";
  return "text-white/35";
}

export function OnyxSetupAssistant() {
  const [question, setQuestion] = useState("");
  const [conversation, setConversation] = useState<ConversationItem[]>([]);
  const guideQuery = useQuery({
    queryKey: ["onyx-setup-guide"],
    queryFn: () => getOnyxSetupGuide(),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
  const ask = useMutation({
    mutationFn: (nextQuestion: string) => askOnyxSetupGuide({ data: { question: nextQuestion } }),
    onMutate: () => beginOnyxThinking(),
    onSettled: () => endOnyxThinking(),
    onSuccess: (result) => {
      setConversation((items) => [...items, { role: "assistant", content: result.answer }]);
    },
    onError: () => {
      setConversation((items) => [
        ...items,
        {
          role: "assistant",
          content: "I could not refresh that answer. Your setup checklist is still current below.",
        },
      ]);
    },
  });

  const guide = guideQuery.data;
  const requiredSteps = useMemo(
    () => guide?.steps.filter((step) => step.required) ?? [],
    [guide?.steps],
  );

  function submit(nextQuestion = question) {
    const trimmed = nextQuestion.trim();
    if (trimmed.length < 2 || ask.isPending) return;
    setConversation((items) => [...items, { role: "user", content: trimmed }]);
    setQuestion("");
    ask.mutate(trimmed);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit();
  }

  if (guideQuery.isLoading) {
    return (
      <div className="tb-neu-inset grid min-h-52 place-items-center rounded-[26px]">
        <Loader2 className="h-5 w-5 animate-spin text-cyan-300" />
      </div>
    );
  }

  if (!guide) {
    return (
      <div className="tb-neu-inset rounded-[26px] p-4 text-sm text-white/60">
        Onyx cannot read your setup right now. Your account and trading controls were not changed.
      </div>
    );
  }

  return (
    <section aria-labelledby="onyx-guide-heading" className="space-y-4">
      <div className="tb-neu-panel rounded-[26px] p-4">
        <div className="flex items-start gap-3">
          <span className="tb-neu-raised grid h-10 w-10 shrink-0 place-items-center rounded-full text-cyan-300">
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-300/75">
              Always ready
            </p>
            <h2 id="onyx-guide-heading" className="mt-1 font-display text-xl">
              Hello {guide.displayName}, what can I simplify?
            </h2>
            <p className="mt-2 text-xs leading-5 text-white/55">{guide.summary}</p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2">
          <Stat label="Venues" value={guide.stats.connectedVenues} />
          <Stat label="Paper trades" value={guide.stats.paperTrades} />
          <Stat label="Open" value={guide.stats.openPositions} />
        </div>
      </div>

      {conversation.length > 0 ? (
        <div
          className="tb-neu-inset max-h-72 space-y-3 overflow-y-auto rounded-[24px] p-3"
          aria-live="polite"
        >
          {conversation.map((message, index) =>
            message.role === "user" ? (
              <div
                key={`${message.role}-${index}`}
                className="ml-auto w-fit max-w-[88%] rounded-2xl bg-white/[0.07] px-3 py-2 text-xs leading-5 text-white/80"
              >
                {message.content}
              </div>
            ) : (
              <div
                key={`${message.role}-${index}`}
                className="max-w-[95%] text-xs leading-5 text-white/70"
              >
                <MessageResponse>{message.content}</MessageResponse>
              </div>
            ),
          )}
          {ask.isPending ? (
            <div className="flex items-center gap-2 text-xs text-cyan-300/70">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking your account and the market…
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => submit(suggestion)}
            disabled={ask.isPending}
            className="tb-neu-raised shrink-0 rounded-full px-3 py-2 text-[11px] text-white/65 transition hover:text-white disabled:opacity-50"
          >
            {suggestion}
          </button>
        ))}
      </div>

      <form onSubmit={onSubmit} className="tb-neu-inset flex items-end gap-2 rounded-[24px] p-2">
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          rows={1}
          maxLength={500}
          placeholder="Ask Onyx to find a setup or simplify anything…"
          aria-label="Ask Onyx"
          className="min-h-11 flex-1 resize-none bg-transparent px-3 py-3 text-sm text-white outline-none placeholder:text-white/30"
        />
        <button
          type="submit"
          disabled={question.trim().length < 2 || ask.isPending}
          aria-label="Send to Onyx"
          className="tb-neu-raised grid h-11 w-11 shrink-0 place-items-center rounded-full text-cyan-300 disabled:opacity-35"
        >
          {ask.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ArrowUp className="h-4 w-4" />
          )}
        </button>
      </form>

      <div className="tb-neu-panel rounded-[24px] p-3">
        <div className="flex items-center justify-between px-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/40">
            Required to trade
          </p>
          <span className="text-[10px] text-white/35">
            {guide.completeCount}/{guide.requiredCount}
          </span>
        </div>
        <div className="mt-2 space-y-2">
          {requiredSteps.map((step) => (
            <Link
              key={step.key}
              to={step.to}
              className="tb-neu-inset flex items-center gap-3 rounded-2xl px-3 py-3"
            >
              <span className={stepTone(step)}>
                {step.complete ? <Check className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
              </span>
              <span className="min-w-0 flex-1">
                <strong className="block text-xs text-white/80">{step.label}</strong>
                <span className="mt-0.5 block truncate text-[10px] text-white/35">
                  {step.detail}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 text-white/25" />
            </Link>
          ))}
        </div>
      </div>

      <p className="px-2 text-center text-[10px] leading-4 text-white/30">
        Onyx reads current account state each time. It never asks for keys, takes custody, or places
        a live order without your review.
      </p>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="tb-neu-inset rounded-2xl px-2 py-3 text-center">
      <p className="text-lg font-semibold tabular-nums text-white">{value}</p>
      <p className="mt-0.5 text-[9px] uppercase tracking-[0.12em] text-white/35">{label}</p>
    </div>
  );
}
