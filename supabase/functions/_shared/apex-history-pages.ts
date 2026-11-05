// A cursor may advance only after the entire bounded venue interval was read.
// Never return a truncated success when page 0 contains the newest fills.
export async function readApexPages<T>(opts: {
  read: (page: number) => Promise<{ ok: boolean; data?: unknown; reason?: string }>;
  keys: string[];
  pageSize: number;
  maxPages?: number;
}): Promise<{ ok: true; rows: T[] } | { ok: false; reason: string }> {
  const rows: T[] = [];
  let expectedTotal: number | null = null;
  for (let page = 0; page < (opts.maxPages ?? 50); page++) {
    const result = await opts.read(page);
    if (!result.ok) return { ok: false, reason: result.reason ?? "APEX_HISTORY_READ_FAILED" };
    const data = result.data;
    const object = data && typeof data === "object" ? data as Record<string, unknown> : {};
    const list = Array.isArray(data) ? data : opts.keys.map(k => object[k]).find(Array.isArray);
    if (!Array.isArray(list) || list.length > opts.pageSize) return { ok: false, reason: "APEX_HISTORY_SHAPE_INVALID" };
    if (object.totalSize !== undefined) {
      const total = Number(object.totalSize);
      if (!Number.isSafeInteger(total) || total < 0 || (expectedTotal !== null && total !== expectedTotal)) {
        return { ok: false, reason: "APEX_HISTORY_TOTAL_CHANGED" };
      }
      expectedTotal = total;
    }
    rows.push(...list as T[]);
    if (list.length < opts.pageSize || rows.length === expectedTotal) {
      if (expectedTotal !== null && rows.length !== expectedTotal) return { ok: false, reason: "APEX_HISTORY_INCOMPLETE" };
      return { ok: true, rows };
    }
    if (expectedTotal !== null && rows.length > expectedTotal) return { ok: false, reason: "APEX_HISTORY_INCOMPLETE" };
  }
  return { ok: false, reason: "APEX_HISTORY_PAGE_LIMIT" };
}
