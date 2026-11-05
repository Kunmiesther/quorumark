/**
 * ProofUploadDialog — private upload flow for a bill's payment proof.
 *
 * Uploads directly from the browser to Storage bucket `bill-proofs`,
 * scoped to `<user_id>/<bill_id>/<timestamp>-<name>`. On success calls
 * `markBillPaid`, which persists the path and awards +75 life points
 * (idempotently — repeated uploads for the same bill do not double-award).
 */
import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Upload, X, CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { markBillPaid, clearBillPaid } from "@/lib/bills/bills.functions";

export function ProofUploadDialog({
  billId,
  billName,
  paidAt,
  onClose,
}: {
  billId: string;
  billName: string;
  paidAt: string | null;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const mark = useServerFn(markBillPaid);
  const clear = useServerFn(clearBillPaid);

  const upload = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error("Sign in first.");
      if (!file) throw new Error("Choose a file.");
      if (file.size > 6 * 1024 * 1024) throw new Error("Max 6MB.");
      const clean = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
      const path = `${user.id}/${billId}/${Date.now()}-${clean}`;
      const { error } = await supabase.storage.from("bill-proofs").upload(path, file, {
        cacheControl: "3600",
        upsert: false,
        contentType: file.type || "application/octet-stream",
      });
      if (error) throw new Error(`upload: ${error.message}`);
      const res = await mark({ data: { id: billId, proof_path: path } });
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bills"] });
      qc.invalidateQueries({ queryKey: ["life-points-total"] });
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  const clearMut = useMutation({
    mutationFn: async () => clear({ data: { id: billId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bills"] });
      onClose();
    },
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-3xl bg-[#0b0b12] p-6 ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[#9945FF]">
              Proof of payment
            </p>
            <h3 className="mt-1 text-[16px] font-semibold text-white">{billName}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-white/50 hover:bg-white/[0.06] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {paidAt ? (
          <>
            <div className="mb-4 flex items-center gap-2 rounded-xl bg-[#14F195]/10 px-3 py-2 text-[12px] text-[#14F195]">
              <CheckCircle2 className="h-4 w-4" />
              Marked paid {new Date(paidAt).toLocaleDateString()}
            </div>
            <button
              type="button"
              onClick={() => clearMut.mutate()}
              disabled={clearMut.isPending}
              className="w-full rounded-lg border border-white/10 py-2 text-[12px] font-semibold text-white/70 transition hover:bg-white/[0.04] disabled:opacity-50"
            >
              {clearMut.isPending ? "Clearing…" : "Reset to unpaid"}
            </button>
          </>
        ) : (
          <>
            <p className="mb-3 text-[12px] text-white/60">
              Upload a receipt, bank confirmation, or screenshot. Only you can
              see it. Files stay private in your account.
            </p>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="mb-3 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 bg-white/[0.03] py-6 text-[12px] text-white/60 transition hover:bg-white/[0.06]"
            >
              <Upload className="h-4 w-4" />
              {file ? file.name : "Choose proof file"}
            </button>
            <input
              ref={inputRef}
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              onChange={(e) => {
                setErr(null);
                setFile(e.target.files?.[0] ?? null);
              }}
            />
            {err && <p className="mb-2 text-[11px] text-[#ff5c8a]">{err}</p>}
            <button
              type="button"
              onClick={() => upload.mutate()}
              disabled={!file || upload.isPending}
              className="w-full rounded-lg bg-[#9945FF] py-2 text-[12px] font-semibold text-white shadow-[0_0_20px_-4px_#9945FF] transition hover:brightness-110 disabled:opacity-50"
            >
              {upload.isPending ? "Uploading…" : "Mark paid · +75 life points"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
