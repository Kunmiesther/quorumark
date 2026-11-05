/**
 * TickAllocator — the SINGLE authoritative allocator for one paper tick.
 *
 * Reconciles universe capacity (`paper_execution_slots` → CapacitySummary)
 * with the actual Onyx-approved throughput in Phase C, and prevents two
 * approvals in the same tick — or the tick that runs immediately after a
 * slot refill — from opening duplicate paper_positions on the same wallet
 * or the same (symbol, direction).
 *
 * Contract:
 *   - One allocator per `runPaperTick` call. Constructed after wallets and
 *     open positions are loaded and BEFORE Phase C begins executing approvals.
 *   - `tryReserve` is the ONLY way Phase C is allowed to commit a wallet slot
 *     to a new position; every openDynamic / repoOpenPosition call must be
 *     immediately preceded by a successful reservation.
 *   - `release` MUST be called if the downstream open fails, so the reserved
 *     wallet + (symbol, direction) become available to a later candidate in
 *     the same tick.
 *
 * Pure in-memory. All persistence still happens through paper_open_position
 * (atomic SECURITY DEFINER) and podService.authorizeAndOpen — the allocator
 * only decides IF we're allowed to attempt.
 */
export type Direction = "long" | "short";

export interface AllocatorWallet {
  walletKey: string;
  /** Cross-margin balance available on this wallet slot. */
  balance: number;
  /** True if the wallet already owns an open position at tick start. */
  occupied: boolean;
}

export interface AllocatorOpenPosition {
  symbol: string;
  direction: Direction;
  walletKey: string;
}

export interface AllocatorInputs {
  /**
   * Hard ceiling on NEW-entry symbols this tick. Comes from
   * `resolveCapacity(...).maxNewEntries`. Retention (a symbol already open
   * at tick start) does NOT consume this budget.
   */
  maxNewEntries: number;
  /**
   * Symbols currently holding a slot at tick start. Used to distinguish
   * retention from a genuinely new entry.
   */
  activeSymbols: readonly string[];
  wallets: readonly AllocatorWallet[];
  openPositions: readonly AllocatorOpenPosition[];
  /**
   * Universe gate allow-list. If non-empty, only these symbols may originate
   * a new entry (symbols already active are always allowed to retain).
   * Pass an empty set to disable the check (legacy / non-dynamic-universe).
   */
  allowedNewEntries: ReadonlySet<string>;
}

export type ReserveReason =
  | "not_in_universe"
  | "duplicate_symbol_direction"
  | "no_new_entry_capacity"
  | "wallet_occupied"
  | "wallet_reserved"
  | "no_free_wallet"
  | "insufficient_balance"
  | "unknown_wallet";

export type ReserveResult =
  | { ok: true; walletKey: string; consumedNewEntry: boolean; token: ReserveToken }
  | { ok: false; reason: ReserveReason };

export interface ReserveToken {
  readonly walletKey: string;
  readonly symbol: string;
  readonly direction: Direction;
  readonly consumedNewEntry: boolean;
}

export interface ReserveInput {
  symbol: string;
  direction: Direction;
  requiredMargin: number;
  /**
   * Preferred wallet key. Phase A candidates always pin a specific wallet
   * (hunter/sniper/accumulator/scout ingestion), so pass it here.
   * Omit to have the allocator pick the first eligible wallet.
   */
  preferredWalletKey?: string;
  /**
   * Explicit hedge exception. When true, a second reservation on the SAME
   * (symbol, opposite direction) is allowed even if the symbol already has
   * an open leg. Duplicate (symbol, SAME direction) is never allowed.
   */
  allowHedge?: boolean;
}

export class TickAllocator {
  private newEntriesUsed = 0;
  private readonly walletBalance = new Map<string, number>();
  /** `${walletKey}:${symbol}` campaign slots. Role wallets can hold several
   *  symbols, but never two campaigns for the same symbol. */
  private readonly walletOccupiedSlots = new Set<string>();
  private readonly walletReservedSlots = new Set<string>();
  /** `${symbol}:${direction}` for both persisted open + in-tick reservations. */
  private readonly claimedSymDir = new Set<string>();
  /** Symbols consuming a capacity slot right now (persisted OR reserved this tick). */
  private readonly activeOrReservedSymbols = new Set<string>();
  private readonly allowedNewEntries: ReadonlySet<string>;
  private readonly _maxNewEntries: number;

  constructor(inputs: AllocatorInputs) {
    this._maxNewEntries = Math.max(0, Math.floor(inputs.maxNewEntries));
    this.allowedNewEntries = inputs.allowedNewEntries;
    for (const w of inputs.wallets) {
      this.walletBalance.set(w.walletKey, Number(w.balance) || 0);
    }
    for (const p of inputs.openPositions) {
      this.claimedSymDir.add(`${p.symbol}:${p.direction}`);
      this.walletOccupiedSlots.add(`${p.walletKey}:${p.symbol}`);
      this.activeOrReservedSymbols.add(p.symbol);
    }
    for (const s of inputs.activeSymbols) this.activeOrReservedSymbols.add(s);
  }

  get remainingNewEntries(): number {
    return Math.max(0, this._maxNewEntries - this.newEntriesUsed);
  }

  get maxNewEntries(): number {
    return this._maxNewEntries;
  }

  tryReserve(input: ReserveInput): ReserveResult {
    const symDir = `${input.symbol}:${input.direction}`;

    // 1) Duplicate (symbol, direction) — either already open, or already
    //    reserved earlier this tick. `allowHedge` waives this ONLY for the
    //    opposing direction; same-direction duplicates are never allowed.
    if (this.claimedSymDir.has(symDir)) {
      return { ok: false, reason: "duplicate_symbol_direction" };
    }

    // 2) Universe gate — new entry must be in the allow-list unless the
    //    symbol is already active (retention). Empty allow-list disables.
    const symbolAlreadyActive = this.activeOrReservedSymbols.has(input.symbol);
    if (symbolAlreadyActive && !input.allowHedge) {
      return { ok: false, reason: "duplicate_symbol_direction" };
    }
    if (this.allowedNewEntries.size > 0 && !symbolAlreadyActive && !this.allowedNewEntries.has(input.symbol)) {
      return { ok: false, reason: "not_in_universe" };
    }

    // 3) Capacity — retention costs 0; a brand-new symbol costs 1 slot.
    const isNewSymbol = !symbolAlreadyActive;
    if (isNewSymbol && this.remainingNewEntries <= 0) {
      return { ok: false, reason: "no_new_entry_capacity" };
    }

    // 4) Wallet selection.
    let picked: string | null = null;
    if (input.preferredWalletKey) {
      const wk = input.preferredWalletKey;
      const walletSlot = `${wk}:${input.symbol}`;
      if (!this.walletBalance.has(wk)) return { ok: false, reason: "unknown_wallet" };
      if (this.walletOccupiedSlots.has(walletSlot)) return { ok: false, reason: "wallet_occupied" };
      if (this.walletReservedSlots.has(walletSlot)) return { ok: false, reason: "wallet_reserved" };
      if ((this.walletBalance.get(wk) ?? 0) < input.requiredMargin) {
        return { ok: false, reason: "insufficient_balance" };
      }
      picked = wk;
    } else {
      for (const [wk, bal] of this.walletBalance) {
        const walletSlot = `${wk}:${input.symbol}`;
        if (this.walletOccupiedSlots.has(walletSlot)) continue;
        if (this.walletReservedSlots.has(walletSlot)) continue;
        if (bal < input.requiredMargin) continue;
        picked = wk;
        break;
      }
      if (!picked) return { ok: false, reason: "no_free_wallet" };
    }

    // Commit reservation atomically (in-memory).
    this.walletReservedSlots.add(`${picked}:${input.symbol}`);
    this.claimedSymDir.add(symDir);
    let consumedNewEntry = false;
    if (isNewSymbol) {
      this.newEntriesUsed += 1;
      this.activeOrReservedSymbols.add(input.symbol);
      consumedNewEntry = true;
    }
    // Silence unused-param lint: allowHedge is part of the public API for
    // callers to opt in explicitly; opposing-direction hedges are already
    // permitted because same-direction is what the dup check blocks.
    void input.allowHedge;

    return {
      ok: true,
      walletKey: picked,
      consumedNewEntry,
      token: { walletKey: picked, symbol: input.symbol, direction: input.direction, consumedNewEntry },
    };
  }

  release(token: ReserveToken): void {
    this.walletReservedSlots.delete(`${token.walletKey}:${token.symbol}`);
    this.claimedSymDir.delete(`${token.symbol}:${token.direction}`);
    if (token.consumedNewEntry) {
      this.newEntriesUsed = Math.max(0, this.newEntriesUsed - 1);
      // Only free the symbol from the active set if nothing else still holds it.
      const stillHeld =
        this.claimedSymDir.has(`${token.symbol}:long`) ||
        this.claimedSymDir.has(`${token.symbol}:short`);
      if (!stillHeld) this.activeOrReservedSymbols.delete(token.symbol);
    }
  }
}
