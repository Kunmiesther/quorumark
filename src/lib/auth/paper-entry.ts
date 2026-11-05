const KEY = "tb_paper_entry_v1";
const MAX_AGE_MS = 60 * 60 * 1000;

// A fixed local destination, never a caller-supplied redirect URL. This is
// navigation intent only: it cannot arm, disarm or authorize any strategy.
export function rememberPaperEntry(
  paper: boolean,
  storage: Storage = sessionStorage,
  now = Date.now(),
) {
  try {
    if (paper) storage.setItem(KEY, String(now));
    else storage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

export function hasPaperEntry(storage: Storage = sessionStorage, now = Date.now()) {
  try {
    const saved = storage.getItem(KEY);
    const timestamp = saved === null ? NaN : Number(saved);
    return Number.isFinite(timestamp) && timestamp <= now && now - timestamp < MAX_AGE_MS;
  } catch {
    return false;
  }
}

export function consumePaperEntry(storage: Storage = sessionStorage, now = Date.now()) {
  const paper = hasPaperEntry(storage, now);
  rememberPaperEntry(false, storage);
  return paper;
}
