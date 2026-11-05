import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowUp, Bot, Loader2 } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { MessageResponse } from "@/components/ai-elements/message";
import { askOnyxSetupGuide } from "@/lib/onyx/setup-guide.functions";
import onyxHead from "@/assets/onyx-head.png.asset.json";

type Message = { role: "user" | "assistant"; content: string; source?: string };
const prompts = [
  "Walk me through setting up automation",
  "How do I map wallets to exchanges?",
  "What is missing before live operation?",
  "How does Life Map track results?",
];

export function AutopilotOnyxChat({ onOpenBuilder }: { onOpenBuilder: () => void }) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const ask = useMutation({
    mutationFn: (question: string) =>
      askOnyxSetupGuide({ data: { question, context: "automation" } }),
    onSuccess: (result) =>
      setMessages((current) => [
        ...current,
        { role: "assistant", content: result.answer, source: result.source },
      ]),
    onError: () =>
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content:
            "I cannot read the current automation setup right now. No settings or trades were changed.",
          source: "error",
        },
      ]),
  });

  function send(value = draft) {
    const question = value.trim();
    if (question.length < 2 || ask.isPending) return;
    setMessages((current) => [...current, { role: "user", content: question }]);
    setDraft("");
    ask.mutate(question);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    send();
  }

  return (
    <section
      className="tb-neu-panel min-w-0 rounded-[28px] p-4 lg:p-5"
      aria-labelledby="autopilot-onyx-heading"
    >
      <div className="flex items-center gap-3">
        <img src={onyxHead.url} alt="" className="h-12 w-12 shrink-0 object-contain" />
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.18em] text-cyan-300/75">Setup guide</p>
          <h2 id="autopilot-onyx-heading" className="font-display text-lg">
            Build with Onyx
          </h2>
        </div>
      </div>
      <p className="mt-3 text-xs leading-5 text-white/55">
        I’ll walk you through the goal, Turtles, symbols, venue and wallet for each symbol, sizing,
        schedule, and risk boundaries. I can explain your setup; only your final approval changes
        execution settings.
      </p>
      <div
        className="tb-neu-inset mt-3 max-h-72 min-h-28 space-y-3 overflow-y-auto rounded-2xl p-3"
        aria-live="polite"
      >
        {messages.length === 0 ? (
          <p className="text-xs leading-5 text-white/45">
            Ask me to start, or use the guided builder beside this chat. I will use your actual
            connected venues and saved plans when answering.
          </p>
        ) : null}
        {messages.map((message, index) => (
          <div
            key={`${message.role}-${index}`}
            className={
              message.role === "user"
                ? "ml-auto max-w-[90%] rounded-2xl bg-violet-400/[0.12] px-3 py-2 text-xs"
                : "max-w-[95%] rounded-2xl bg-white/[0.04] px-3 py-2 text-xs leading-5"
            }
          >
            {message.role === "assistant" ? (
              <>
                <MessageResponse>{message.content}</MessageResponse>
                <p className="mt-2 text-[10px] text-white/35">
                  {message.source === "ai" ? "Onyx AI guidance" : "Account-based guidance"} · no
                  trading action taken
                </p>
              </>
            ) : (
              message.content
            )}
          </div>
        ))}
        {ask.isPending ? (
          <p className="flex items-center gap-2 text-xs text-cyan-300">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading your setup…
          </p>
        ) : null}
      </div>
      <div className="mt-3 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
        {prompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            disabled={ask.isPending}
            onClick={() => send(prompt)}
            className="tb-neu-raised shrink-0 rounded-full px-3 py-2 text-[11px] text-white/65 disabled:opacity-50"
          >
            {prompt}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="tb-neu-inset mt-2 flex items-end gap-2 rounded-2xl p-2">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          rows={1}
          maxLength={500}
          placeholder="Ask Onyx about your automation…"
          aria-label="Chat with Onyx about automation"
          className="min-h-11 min-w-0 flex-1 resize-none bg-transparent px-2 py-3 text-sm text-white outline-none placeholder:text-white/35"
        />
        <button
          type="submit"
          disabled={draft.trim().length < 2 || ask.isPending}
          aria-label="Send message to Onyx"
          className="tb-neu-raised grid h-11 w-11 shrink-0 place-items-center rounded-full text-cyan-300 disabled:opacity-35"
        >
          {ask.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ArrowUp className="h-4 w-4" />
          )}
        </button>
      </form>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <button
          type="button"
          onClick={onOpenBuilder}
          className="tb-neu-raised inline-flex items-center gap-2 rounded-full px-3 py-2 text-violet-200"
        >
          <Bot className="h-3.5 w-3.5" /> Open guided builder
        </button>
        <Link to="/exchanges" className="tb-neu-raised rounded-full px-3 py-2 text-white/65">
          Connect exchanges & wallets
        </Link>
        <Link to="/life-map" className="tb-neu-raised rounded-full px-3 py-2 text-white/65">
          Life Map
        </Link>
      </div>
    </section>
  );
}
