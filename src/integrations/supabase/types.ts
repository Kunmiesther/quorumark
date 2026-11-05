export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      synfutures_account_registrations: {
        Row: { id: string; user_id: string; wallet_id: string; setup_id: string; setup_revision: number; chain_id: number; owner_address: string; safe_address: string; module_address: string; safe_proxy_code_hash: string; module_code_hash: string; verified_block_number: number; verified_block_hash: string; verified_block_time: string; status: "deployed_operator_pending"; created_at: string; verified_at: string }
        Insert: { user_id: string; wallet_id: string; setup_id: string; setup_revision: number; owner_address: string; safe_address: string; module_address: string; safe_proxy_code_hash: string; module_code_hash: string; verified_block_number: number; verified_block_hash: string; verified_block_time: string; id?: string; chain_id?: number; status?: "deployed_operator_pending"; created_at?: string; verified_at?: string }
        Update: { setup_revision?: number; verified_block_number?: number; verified_block_hash?: string; verified_block_time?: string }
        Relationships: []
      }
      synfutures_setup_drafts: {
        Row: { id: string; user_id: string; wallet_id: string; allocation_usdc: number; max_leverage: number; chain_id: number; status: "draft"; revision: number; created_at: string; updated_at: string }
        Insert: { id?: string; user_id: string; wallet_id: string; allocation_usdc: number; max_leverage: number; chain_id?: number; status?: "draft"; revision?: number; created_at?: string; updated_at?: string }
        Update: { allocation_usdc?: number; max_leverage?: number }
        Relationships: [{ foreignKeyName: "synfutures_setup_drafts_wallet_id_fkey"; columns: ["wallet_id"]; isOneToOne: false; referencedRelation: "wallet_connections"; referencedColumns: ["id"] }]
      }
      autopilot_workflows: {
        Row: { active_days: number[]; approved_at: string | null; archived_at: string | null; authorized_capital: number; connection_id: string | null; created_at: string; enabled_turtles: string[]; evaluated_at: string | null; goal_id: string; goal_label: string; id: string; income_allocation_pct: number; loss_limit: number; margin_pct: number; max_daily_entries: number; max_open_positions: number; name: string; paused_at: string | null; pause_reason: string | null; proposal: Json; risk_mode: string; rung_count: number; schedule_enabled: boolean; status: string; strategy_id: string; symbols: string[]; target_days: number; timezone: string; updated_at: string; user_id: string; validation: Json; window_end: string; window_start: string }
        Insert: { active_days?: number[]; approved_at?: string | null; archived_at?: string | null; authorized_capital: number; connection_id?: string | null; created_at?: string; enabled_turtles?: string[]; evaluated_at?: string | null; goal_id: string; goal_label: string; id?: string; income_allocation_pct?: number; loss_limit: number; margin_pct?: number; max_daily_entries?: number; max_open_positions?: number; name: string; paused_at?: string | null; pause_reason?: string | null; proposal?: Json; risk_mode: string; rung_count?: number; schedule_enabled?: boolean; status?: string; strategy_id: string; symbols?: string[]; target_days: number; timezone?: string; updated_at?: string; user_id: string; validation?: Json; window_end?: string; window_start?: string }
        Update: { active_days?: number[]; approved_at?: string | null; archived_at?: string | null; authorized_capital?: number; connection_id?: string | null; created_at?: string; enabled_turtles?: string[]; evaluated_at?: string | null; goal_id?: string; goal_label?: string; id?: string; income_allocation_pct?: number; loss_limit?: number; margin_pct?: number; max_daily_entries?: number; max_open_positions?: number; name?: string; paused_at?: string | null; pause_reason?: string | null; proposal?: Json; risk_mode?: string; rung_count?: number; schedule_enabled?: boolean; status?: string; strategy_id?: string; symbols?: string[]; target_days?: number; timezone?: string; updated_at?: string; user_id?: string; validation?: Json; window_end?: string; window_start?: string }
        Relationships: [{ foreignKeyName: "autopilot_workflows_connection_id_fkey"; columns: ["connection_id"]; isOneToOne: false; referencedRelation: "exchange_connections"; referencedColumns: ["id"] }, { foreignKeyName: "autopilot_workflows_strategy_id_fkey"; columns: ["strategy_id"]; isOneToOne: false; referencedRelation: "strategies"; referencedColumns: ["id"] }]
      }
      access_entitlements: {
        Row: {
          community_id: string | null
          created_at: string
          expires_at: string | null
          granted_at: string
          id: string
          plan_key: string
          source: Database["public"]["Enums"]["entitlement_source"]
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          community_id?: string | null
          created_at?: string
          expires_at?: string | null
          granted_at?: string
          id?: string
          plan_key: string
          source: Database["public"]["Enums"]["entitlement_source"]
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          community_id?: string | null
          created_at?: string
          expires_at?: string | null
          granted_at?: string
          id?: string
          plan_key?: string
          source?: Database["public"]["Enums"]["entitlement_source"]
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "access_entitlements_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "trading_communities"
            referencedColumns: ["id"]
          },
        ]
      }
      agentic_promotion_gate: {
        Row: {
          agentic_live_enabled: boolean
          created_at: string
          max_degraded_rate_pct: number
          max_drawdown_pct: number
          min_expectancy: number
          min_net_pnl: number
          min_profit_factor: number
          min_sample_size: number
          owner_approved: boolean
          owner_approved_at: string | null
          require_zero_missing_trace: boolean
          require_zero_risk_violations: boolean
          thresholds_note: string
          updated_at: string
          user_id: string
        }
        Insert: {
          agentic_live_enabled?: boolean
          created_at?: string
          max_degraded_rate_pct?: number
          max_drawdown_pct?: number
          min_expectancy?: number
          min_net_pnl?: number
          min_profit_factor?: number
          min_sample_size?: number
          owner_approved?: boolean
          owner_approved_at?: string | null
          require_zero_missing_trace?: boolean
          require_zero_risk_violations?: boolean
          thresholds_note?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          agentic_live_enabled?: boolean
          created_at?: string
          max_degraded_rate_pct?: number
          max_drawdown_pct?: number
          min_expectancy?: number
          min_net_pnl?: number
          min_profit_factor?: number
          min_sample_size?: number
          owner_approved?: boolean
          owner_approved_at?: string | null
          require_zero_missing_trace?: boolean
          require_zero_risk_violations?: boolean
          thresholds_note?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      agentic_rule_proposals: {
        Row: {
          created_at: string
          decided_at: string | null
          decided_by: string | null
          evidence: Json
          id: string
          proposed_change: Json
          rationale: string
          sample_size: number
          scope: string
          status: string
          title: string
          user_id: string
        }
        Insert: {
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          evidence?: Json
          id?: string
          proposed_change?: Json
          rationale?: string
          sample_size?: number
          scope: string
          status?: string
          title: string
          user_id: string
        }
        Update: {
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          evidence?: Json
          id?: string
          proposed_change?: Json
          rationale?: string
          sample_size?: number
          scope?: string
          status?: string
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      agentic_sweep_runs: {
        Row: {
          detail: Json
          error_categories: string[]
          errors: number
          events_written: number
          finished_at: string | null
          id: string
          positions_discovered: number
          positions_eligible: number
          runtime_version: string
          skipped_by_reason: Json
          started_at: string
          status: string
          user_id: string
        }
        Insert: {
          detail?: Json
          error_categories?: string[]
          errors?: number
          events_written?: number
          finished_at?: string | null
          id?: string
          positions_discovered?: number
          positions_eligible?: number
          runtime_version: string
          skipped_by_reason?: Json
          started_at?: string
          status?: string
          user_id: string
        }
        Update: {
          detail?: Json
          error_categories?: string[]
          errors?: number
          events_written?: number
          finished_at?: string | null
          id?: string
          positions_discovered?: number
          positions_eligible?: number
          runtime_version?: string
          skipped_by_reason?: Json
          started_at?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      ai_committee_evaluations: {
        Row: {
          advisory: boolean
          available_roles: string[]
          candidate_id: string
          candle_close_at: string
          consensus_confidence: number | null
          consensus_direction: string | null
          created_at: string
          evidence_hash: string
          id: string
          outcomes: Json
          prompt_version: string
          realized_at: string | null
          realized_outcome: string | null
          realized_pnl: number | null
          risk_dissent: boolean
          risk_flags: string[]
          schema_version: string
          score_band: string | null
          scorer_version: string
          shadow_score: number | null
          snapshot: Json
          strategy: string
          symbol: string
          timeframe: string
          total_latency_ms: number | null
          unavailable_roles: string[]
          user_id: string
          verdict: string
        }
        Insert: {
          advisory?: boolean
          available_roles?: string[]
          candidate_id: string
          candle_close_at: string
          consensus_confidence?: number | null
          consensus_direction?: string | null
          created_at?: string
          evidence_hash: string
          id?: string
          outcomes?: Json
          prompt_version?: string
          realized_at?: string | null
          realized_outcome?: string | null
          realized_pnl?: number | null
          risk_dissent?: boolean
          risk_flags?: string[]
          schema_version: string
          score_band?: string | null
          scorer_version?: string
          shadow_score?: number | null
          snapshot: Json
          strategy: string
          symbol: string
          timeframe: string
          total_latency_ms?: number | null
          unavailable_roles?: string[]
          user_id?: string
          verdict: string
        }
        Update: {
          advisory?: boolean
          available_roles?: string[]
          candidate_id?: string
          candle_close_at?: string
          consensus_confidence?: number | null
          consensus_direction?: string | null
          created_at?: string
          evidence_hash?: string
          id?: string
          outcomes?: Json
          prompt_version?: string
          realized_at?: string | null
          realized_outcome?: string | null
          realized_pnl?: number | null
          risk_dissent?: boolean
          risk_flags?: string[]
          schema_version?: string
          score_band?: string | null
          scorer_version?: string
          shadow_score?: number | null
          snapshot?: Json
          strategy?: string
          symbol?: string
          timeframe?: string
          total_latency_ms?: number | null
          unavailable_roles?: string[]
          user_id?: string
          verdict?: string
        }
        Relationships: []
      }
      ai_decision_opinions: {
        Row: {
          advisory: boolean
          confidence: number | null
          decision_id: string
          direction: string | null
          evaluated_at: string
          evidence_hash: string
          id: string
          latency_ms: number | null
          model: string
          prompt_version: string
          provider: string
          risk_flags: string[]
          role: string
          status: string
          summary: string | null
          unavailable_reason: string | null
          user_id: string
        }
        Insert: {
          advisory?: boolean
          confidence?: number | null
          decision_id: string
          direction?: string | null
          evaluated_at?: string
          evidence_hash: string
          id?: string
          latency_ms?: number | null
          model: string
          prompt_version: string
          provider: string
          risk_flags?: string[]
          role: string
          status: string
          summary?: string | null
          unavailable_reason?: string | null
          user_id: string
        }
        Update: {
          advisory?: boolean
          confidence?: number | null
          decision_id?: string
          direction?: string | null
          evaluated_at?: string
          evidence_hash?: string
          id?: string
          latency_ms?: number | null
          model?: string
          prompt_version?: string
          provider?: string
          risk_flags?: string[]
          role?: string
          status?: string
          summary?: string | null
          unavailable_reason?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_decision_opinions_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "strategy_decisions"
            referencedColumns: ["decision_id"]
          },
        ]
      }
      apex_credential_audit: {
        Row: {
          created_at: string
          credential_id: string | null
          detail: Json | null
          event: string
          id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          credential_id?: string | null
          detail?: Json | null
          event: string
          id?: string
          user_id: string
        }
        Update: {
          created_at?: string
          credential_id?: string | null
          detail?: Json | null
          event?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "apex_credential_audit_credential_id_fkey"
            columns: ["credential_id"]
            isOneToOne: false
            referencedRelation: "apex_execution_credentials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "apex_credential_audit_credential_id_fkey"
            columns: ["credential_id"]
            isOneToOne: false
            referencedRelation: "apex_execution_credentials_status"
            referencedColumns: ["id"]
          },
        ]
      }
      apex_execution_credentials: {
        Row: {
          active: boolean
          apex_account_id: string | null
          created_at: string
          credential_fingerprint: string
          encrypted_credentials: string
          encryption_key_version: number
          environment: string
          exchange_connection_id: string
          id: string
          last_verified_at: string | null
          revoked_at: string | null
          rotated_at: string | null
          updated_at: string
          user_id: string
          wallet_address: string
        }
        Insert: {
          active?: boolean
          apex_account_id?: string | null
          created_at?: string
          credential_fingerprint: string
          encrypted_credentials: string
          encryption_key_version?: number
          environment: string
          exchange_connection_id: string
          id?: string
          last_verified_at?: string | null
          revoked_at?: string | null
          rotated_at?: string | null
          updated_at?: string
          user_id: string
          wallet_address: string
        }
        Update: {
          active?: boolean
          apex_account_id?: string | null
          created_at?: string
          credential_fingerprint?: string
          encrypted_credentials?: string
          encryption_key_version?: number
          environment?: string
          exchange_connection_id?: string
          id?: string
          last_verified_at?: string | null
          revoked_at?: string | null
          rotated_at?: string | null
          updated_at?: string
          user_id?: string
          wallet_address?: string
        }
        Relationships: [
          {
            foreignKeyName: "apex_execution_credentials_exchange_connection_id_fkey"
            columns: ["exchange_connection_id"]
            isOneToOne: false
            referencedRelation: "active_bot_config"
            referencedColumns: ["connection_id"]
          },
          {
            foreignKeyName: "apex_execution_credentials_exchange_connection_id_fkey"
            columns: ["exchange_connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      apex_onboarding_challenges: {
        Row: {
          challenge_text: string
          consumed_at: string | null
          created_at: string
          environment: string
          expires_at: string
          id: string
          nonce_hash: string
          purpose: string
          user_id: string
          wallet_address: string
        }
        Insert: {
          challenge_text: string
          consumed_at?: string | null
          created_at?: string
          environment: string
          expires_at: string
          id?: string
          nonce_hash: string
          purpose: string
          user_id: string
          wallet_address: string
        }
        Update: {
          challenge_text?: string
          consumed_at?: string | null
          created_at?: string
          environment?: string
          expires_at?: string
          id?: string
          nonce_hash?: string
          purpose?: string
          user_id?: string
          wallet_address?: string
        }
        Relationships: []
      }
      bill_allocations: {
        Row: {
          amount_usd: number
          bill_id: string
          created_at: string
          id: string
          period_key: string
          source: string
          trade_id: string | null
          user_id: string
        }
        Insert: {
          amount_usd: number
          bill_id: string
          created_at?: string
          id?: string
          period_key: string
          source?: string
          trade_id?: string | null
          user_id: string
        }
        Update: {
          amount_usd?: number
          bill_id?: string
          created_at?: string
          id?: string
          period_key?: string
          source?: string
          trade_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bill_allocations_bill_id_fkey"
            columns: ["bill_id"]
            isOneToOne: false
            referencedRelation: "bills"
            referencedColumns: ["id"]
          },
        ]
      }
      bill_payment_intents: {
        Row: {
          amount: number
          created_at: string
          currency: string
          id: string
          idempotency_key: string
          metadata: Json
          obligation_id: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          currency?: string
          id?: string
          idempotency_key: string
          metadata?: Json
          obligation_id: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          currency?: string
          id?: string
          idempotency_key?: string
          metadata?: Json
          obligation_id?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      bill_reallocation_suggestions: {
        Row: {
          created_at: string
          id: string
          notified_telegram_at: string | null
          period_key: string
          resolved_at: string | null
          source_bill_id: string
          status: string
          surplus_usd: number
          targets: Json
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          notified_telegram_at?: string | null
          period_key: string
          resolved_at?: string | null
          source_bill_id: string
          status?: string
          surplus_usd: number
          targets?: Json
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          notified_telegram_at?: string | null
          period_key?: string
          resolved_at?: string | null
          source_bill_id?: string
          status?: string
          surplus_usd?: number
          targets?: Json
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bill_reallocation_suggestions_source_bill_id_fkey"
            columns: ["source_bill_id"]
            isOneToOne: false
            referencedRelation: "bills"
            referencedColumns: ["id"]
          },
        ]
      }
      bill_sync_cursor: {
        Row: {
          last_trade_closed_at: string | null
          last_trade_id: string | null
          source: string
          updated_at: string
          user_id: string
        }
        Insert: {
          last_trade_closed_at?: string | null
          last_trade_id?: string | null
          source?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          last_trade_closed_at?: string | null
          last_trade_id?: string | null
          source?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      bill_withdrawal_links: {
        Row: {
          amount: number
          created_at: string
          currency: string
          id: string
          intent_id: string
          user_id: string
          verified_at: string | null
          withdrawal_ref: string
        }
        Insert: {
          amount: number
          created_at?: string
          currency?: string
          id?: string
          intent_id: string
          user_id: string
          verified_at?: string | null
          withdrawal_ref: string
        }
        Update: {
          amount?: number
          created_at?: string
          currency?: string
          id?: string
          intent_id?: string
          user_id?: string
          verified_at?: string | null
          withdrawal_ref?: string
        }
        Relationships: [
          {
            foreignKeyName: "bill_withdrawal_links_intent_id_fkey"
            columns: ["intent_id"]
            isOneToOne: false
            referencedRelation: "bill_payment_intents"
            referencedColumns: ["id"]
          },
        ]
      }
      bills: {
        Row: {
          amount_usd: number
          archived_at: string | null
          assigned_strategy: string | null
          cadence: string
          category: string | null
          created_at: string
          due_day: number | null
          id: string
          name: string
          paid_at: string | null
          priority: number
          proof_url: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          amount_usd: number
          archived_at?: string | null
          assigned_strategy?: string | null
          cadence: string
          category?: string | null
          created_at?: string
          due_day?: number | null
          id?: string
          name: string
          paid_at?: string | null
          priority?: number
          proof_url?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          amount_usd?: number
          archived_at?: string | null
          assigned_strategy?: string | null
          cadence?: string
          category?: string | null
          created_at?: string
          due_day?: number | null
          id?: string
          name?: string
          paid_at?: string | null
          priority?: number
          proof_url?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      bot_events: {
        Row: {
          created_at: string
          detail: Json
          event: string
          id: number
          level: string
          user_id: string
        }
        Insert: {
          created_at?: string
          detail?: Json
          event: string
          id?: never
          level: string
          user_id: string
        }
        Update: {
          created_at?: string
          detail?: Json
          event?: string
          id?: never
          level?: string
          user_id?: string
        }
        Relationships: []
      }
      bot_heartbeat: {
        Row: {
          credentials_ok: boolean
          id: number
          last_seen: string
          message: string | null
          mode: string
        }
        Insert: {
          credentials_ok?: boolean
          id?: number
          last_seen?: string
          message?: string | null
          mode?: string
        }
        Update: {
          credentials_ok?: boolean
          id?: number
          last_seen?: string
          message?: string | null
          mode?: string
        }
        Relationships: []
      }
      bot_status_events: {
        Row: {
          created_at: string
          id: string
          status: string
          trigger_source: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          status: string
          trigger_source?: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          status?: string
          trigger_source?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      bydfi_verified_universe: {
        Row: {
          base: string
          connection_id: string
          created_at: string
          id: string
          max_leverage: number | null
          min_notional: number | null
          min_qty: number | null
          quote: string
          symbol: string
          tick_size: number | null
          tradable: boolean
          updated_at: string
          user_id: string
          venue_symbol: string
          verified_at: string
          volume_24h_usd: number | null
        }
        Insert: {
          base: string
          connection_id: string
          created_at?: string
          id?: string
          max_leverage?: number | null
          min_notional?: number | null
          min_qty?: number | null
          quote: string
          symbol: string
          tick_size?: number | null
          tradable?: boolean
          updated_at?: string
          user_id: string
          venue_symbol: string
          verified_at?: string
          volume_24h_usd?: number | null
        }
        Update: {
          base?: string
          connection_id?: string
          created_at?: string
          id?: string
          max_leverage?: number | null
          min_notional?: number | null
          min_qty?: number | null
          quote?: string
          symbol?: string
          tick_size?: number | null
          tradable?: boolean
          updated_at?: string
          user_id?: string
          venue_symbol?: string
          verified_at?: string
          volume_24h_usd?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "bydfi_verified_universe_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "active_bot_config"
            referencedColumns: ["connection_id"]
          },
          {
            foreignKeyName: "bydfi_verified_universe_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_outcomes: {
        Row: {
          candidate_id: string
          closed_at: string | null
          created_at: string
          direction: string
          entry_price: number | null
          exit_price: number | null
          id: string
          opened_at: string | null
          outcome: string | null
          r_multiple: number | null
          realized_pnl_usd: number | null
          source: string
          status: string
          strategy: string
          symbol: string
          user_id: string
        }
        Insert: {
          candidate_id: string
          closed_at?: string | null
          created_at?: string
          direction: string
          entry_price?: number | null
          exit_price?: number | null
          id?: string
          opened_at?: string | null
          outcome?: string | null
          r_multiple?: number | null
          realized_pnl_usd?: number | null
          source: string
          status?: string
          strategy: string
          symbol: string
          user_id?: string
        }
        Update: {
          candidate_id?: string
          closed_at?: string | null
          created_at?: string
          direction?: string
          entry_price?: number | null
          exit_price?: number | null
          id?: string
          opened_at?: string | null
          outcome?: string | null
          r_multiple?: number | null
          realized_pnl_usd?: number | null
          source?: string
          status?: string
          strategy?: string
          symbol?: string
          user_id?: string
        }
        Relationships: []
      }
      collectible_notify_prefs: {
        Row: {
          created_at: string
          notify: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          notify?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          notify?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      committee_cycles: {
        Row: {
          book: string
          candidate_count: number
          candle_close_at: string
          completed_at: string | null
          created_at: string
          cycle_key: string
          geometry_version: string | null
          id: string
          no_trade_reason: string | null
          provenance: Json
          reviewed_count: number
          seat_response_count: number
          selected_direction: string | null
          selected_score: number | null
          selected_symbol: string | null
          started_at: string
          status: string
          strategy_version: string
          universe_size: number
          updated_at: string
          user_id: string
        }
        Insert: {
          book?: string
          candidate_count?: number
          candle_close_at: string
          completed_at?: string | null
          created_at?: string
          cycle_key: string
          geometry_version?: string | null
          id?: string
          no_trade_reason?: string | null
          provenance?: Json
          reviewed_count?: number
          seat_response_count?: number
          selected_direction?: string | null
          selected_score?: number | null
          selected_symbol?: string | null
          started_at?: string
          status?: string
          strategy_version?: string
          universe_size?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          book?: string
          candidate_count?: number
          candle_close_at?: string
          completed_at?: string | null
          created_at?: string
          cycle_key?: string
          geometry_version?: string | null
          id?: string
          no_trade_reason?: string | null
          provenance?: Json
          reviewed_count?: number
          seat_response_count?: number
          selected_direction?: string | null
          selected_score?: number | null
          selected_symbol?: string | null
          started_at?: string
          status?: string
          strategy_version?: string
          universe_size?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      committee_shortlist: {
        Row: {
          available_seats: number
          candidate_id: string | null
          consensus_confidence: number | null
          created_at: string
          cycle_id: string
          direction: string
          entry_plan: Json
          evaluation_id: string | null
          evidence_hash: string | null
          expected_net_edge_bps: number | null
          id: string
          liquidity_usd: number | null
          rank: number | null
          rejection_reason: string | null
          risk_objection: Json
          risk_veto: boolean
          score_components: Json
          seat_decisions: Json
          signal_id: string | null
          spread_bps: number | null
          state: string
          symbol: string
          total_score: number | null
          unavailable_seats: number
          updated_at: string
          user_id: string
          verdict: string | null
          volatility_pct: number | null
        }
        Insert: {
          available_seats?: number
          candidate_id?: string | null
          consensus_confidence?: number | null
          created_at?: string
          cycle_id: string
          direction: string
          entry_plan?: Json
          evaluation_id?: string | null
          evidence_hash?: string | null
          expected_net_edge_bps?: number | null
          id?: string
          liquidity_usd?: number | null
          rank?: number | null
          rejection_reason?: string | null
          risk_objection?: Json
          risk_veto?: boolean
          score_components?: Json
          seat_decisions?: Json
          signal_id?: string | null
          spread_bps?: number | null
          state?: string
          symbol: string
          total_score?: number | null
          unavailable_seats?: number
          updated_at?: string
          user_id: string
          verdict?: string | null
          volatility_pct?: number | null
        }
        Update: {
          available_seats?: number
          candidate_id?: string | null
          consensus_confidence?: number | null
          created_at?: string
          cycle_id?: string
          direction?: string
          entry_plan?: Json
          evaluation_id?: string | null
          evidence_hash?: string | null
          expected_net_edge_bps?: number | null
          id?: string
          liquidity_usd?: number | null
          rank?: number | null
          rejection_reason?: string | null
          risk_objection?: Json
          risk_veto?: boolean
          score_components?: Json
          seat_decisions?: Json
          signal_id?: string | null
          spread_bps?: number | null
          state?: string
          symbol?: string
          total_score?: number | null
          unavailable_seats?: number
          updated_at?: string
          user_id?: string
          verdict?: string | null
          volatility_pct?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "committee_shortlist_cycle_id_fkey"
            columns: ["cycle_id"]
            isOneToOne: false
            referencedRelation: "committee_cycles"
            referencedColumns: ["id"]
          },
        ]
      }
      community_audit_events: {
        Row: {
          action: string
          actor_user_id: string | null
          community_id: string | null
          created_at: string
          detail: Json
          id: string
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          community_id?: string | null
          created_at?: string
          detail?: Json
          id?: string
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          community_id?: string | null
          created_at?: string
          detail?: Json
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "community_audit_events_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "trading_communities"
            referencedColumns: ["id"]
          },
        ]
      }
      community_commission_ledger: {
        Row: {
          amount_cents: number
          community_id: string
          created_at: string
          currency: string
          id: string
          period_end: string
          period_start: string
          rule_id: string | null
          source: string
        }
        Insert: {
          amount_cents: number
          community_id: string
          created_at?: string
          currency?: string
          id?: string
          period_end: string
          period_start: string
          rule_id?: string | null
          source?: string
        }
        Update: {
          amount_cents?: number
          community_id?: string
          created_at?: string
          currency?: string
          id?: string
          period_end?: string
          period_start?: string
          rule_id?: string | null
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "community_commission_ledger_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "trading_communities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "community_commission_ledger_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "community_commission_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      community_commission_rules: {
        Row: {
          active: boolean
          amount_cents: number | null
          approved_at: string | null
          approved_by: string | null
          community_id: string
          created_at: string
          id: string
          kind: Database["public"]["Enums"]["commission_kind"]
          percent_bps: number | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          amount_cents?: number | null
          approved_at?: string | null
          approved_by?: string | null
          community_id: string
          created_at?: string
          id?: string
          kind: Database["public"]["Enums"]["commission_kind"]
          percent_bps?: number | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          amount_cents?: number | null
          approved_at?: string | null
          approved_by?: string | null
          community_id?: string
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["commission_kind"]
          percent_bps?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "community_commission_rules_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "trading_communities"
            referencedColumns: ["id"]
          },
        ]
      }
      community_invitations: {
        Row: {
          community_id: string
          created_at: string
          created_by: string | null
          email: string | null
          expires_at: string
          id: string
          max_uses: number
          plan_key: string
          revoked_at: string | null
          token_hash: string
          updated_at: string
          uses: number
        }
        Insert: {
          community_id: string
          created_at?: string
          created_by?: string | null
          email?: string | null
          expires_at: string
          id?: string
          max_uses?: number
          plan_key?: string
          revoked_at?: string | null
          token_hash: string
          updated_at?: string
          uses?: number
        }
        Update: {
          community_id?: string
          created_at?: string
          created_by?: string | null
          email?: string | null
          expires_at?: string
          id?: string
          max_uses?: number
          plan_key?: string
          revoked_at?: string | null
          token_hash?: string
          updated_at?: string
          uses?: number
        }
        Relationships: [
          {
            foreignKeyName: "community_invitations_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "trading_communities"
            referencedColumns: ["id"]
          },
        ]
      }
      community_memberships: {
        Row: {
          community_id: string
          created_at: string
          id: string
          joined_at: string
          role: Database["public"]["Enums"]["community_member_role"]
          status: Database["public"]["Enums"]["community_member_status"]
          updated_at: string
          user_id: string
        }
        Insert: {
          community_id: string
          created_at?: string
          id?: string
          joined_at?: string
          role?: Database["public"]["Enums"]["community_member_role"]
          status?: Database["public"]["Enums"]["community_member_status"]
          updated_at?: string
          user_id: string
        }
        Update: {
          community_id?: string
          created_at?: string
          id?: string
          joined_at?: string
          role?: Database["public"]["Enums"]["community_member_role"]
          status?: Database["public"]["Enums"]["community_member_status"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "community_memberships_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "trading_communities"
            referencedColumns: ["id"]
          },
        ]
      }
      connection_audit_events: {
        Row: {
          connection_id: string | null
          created_at: string
          event: string
          id: string
          metadata: Json
          reason: string | null
          user_id: string
        }
        Insert: {
          connection_id?: string | null
          created_at?: string
          event: string
          id?: string
          metadata?: Json
          reason?: string | null
          user_id: string
        }
        Update: {
          connection_id?: string | null
          created_at?: string
          event?: string
          id?: string
          metadata?: Json
          reason?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "connection_audit_events_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "active_bot_config"
            referencedColumns: ["connection_id"]
          },
          {
            foreignKeyName: "connection_audit_events_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      earnings_allocations: {
        Row: {
          amount: number
          created_at: string
          currency: string
          id: string
          idempotency_key: string
          metadata: Json
          obligation_id: string | null
          source: string
          status: string
          strategy: string | null
          user_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          currency?: string
          id?: string
          idempotency_key: string
          metadata?: Json
          obligation_id?: string | null
          source: string
          status?: string
          strategy?: string | null
          user_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          currency?: string
          id?: string
          idempotency_key?: string
          metadata?: Json
          obligation_id?: string | null
          source?: string
          status?: string
          strategy?: string | null
          user_id?: string
        }
        Relationships: []
      }
      exchange_connections: {
        Row: {
          created_at: string
          display_name: string | null
          environment: string
          exchange: string
          id: string
          is_live: boolean
          last_error: string | null
          last_error_code: string | null
          last_error_message: string | null
          last_health_check_at: string | null
          last_verified_at: string | null
          market_type: Database["public"]["Enums"]["account_mode"]
          permission_read: boolean
          permission_scopes: Json
          permission_trade: boolean
          permission_verified_at: string | null
          permissions_verified: boolean
          status: Database["public"]["Enums"]["connection_status"]
          updated_at: string
          user_id: string
          withdrawals_disabled: boolean
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          environment?: string
          exchange: string
          id?: string
          is_live?: boolean
          last_error?: string | null
          last_error_code?: string | null
          last_error_message?: string | null
          last_health_check_at?: string | null
          last_verified_at?: string | null
          market_type?: Database["public"]["Enums"]["account_mode"]
          permission_read?: boolean
          permission_scopes?: Json
          permission_trade?: boolean
          permission_verified_at?: string | null
          permissions_verified?: boolean
          status?: Database["public"]["Enums"]["connection_status"]
          updated_at?: string
          user_id: string
          withdrawals_disabled?: boolean
        }
        Update: {
          created_at?: string
          display_name?: string | null
          environment?: string
          exchange?: string
          id?: string
          is_live?: boolean
          last_error?: string | null
          last_error_code?: string | null
          last_error_message?: string | null
          last_health_check_at?: string | null
          last_verified_at?: string | null
          market_type?: Database["public"]["Enums"]["account_mode"]
          permission_read?: boolean
          permission_scopes?: Json
          permission_trade?: boolean
          permission_verified_at?: string | null
          permissions_verified?: boolean
          status?: Database["public"]["Enums"]["connection_status"]
          updated_at?: string
          user_id?: string
          withdrawals_disabled?: boolean
        }
        Relationships: []
      }
      exchange_credentials: {
        Row: {
          connection_id: string
          created_at: string
          encrypted_api_key: string
          encrypted_api_secret: string
          encrypted_omni_seed: string | null
          encrypted_passphrase: string | null
          encryption_version: number
          id: string
          rotated_at: string | null
          user_id: string
        }
        Insert: {
          connection_id: string
          created_at?: string
          encrypted_api_key: string
          encrypted_api_secret: string
          encrypted_omni_seed?: string | null
          encrypted_passphrase?: string | null
          encryption_version?: number
          id?: string
          rotated_at?: string | null
          user_id: string
        }
        Update: {
          connection_id?: string
          created_at?: string
          encrypted_api_key?: string
          encrypted_api_secret?: string
          encrypted_omni_seed?: string | null
          encrypted_passphrase?: string | null
          encryption_version?: number
          id?: string
          rotated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "exchange_credentials_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: true
            referencedRelation: "active_bot_config"
            referencedColumns: ["connection_id"]
          },
          {
            foreignKeyName: "exchange_credentials_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: true
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      exchange_leverage_caps: {
        Row: {
          exchange: string
          max_leverage: number
          max_notional: number | null
          min_notional: number
          refreshed_at: string
          symbol: string
        }
        Insert: {
          exchange: string
          max_leverage: number
          max_notional?: number | null
          min_notional?: number
          refreshed_at?: string
          symbol: string
        }
        Update: {
          exchange?: string
          max_leverage?: number
          max_notional?: number | null
          min_notional?: number
          refreshed_at?: string
          symbol?: string
        }
        Relationships: []
      }
      fusion_lead_requests: {
        Row: {
          automation_level: string | null
          company: string | null
          contact_email: string
          contact_name: string
          created_at: string
          delivery_needs: string | null
          id: string
          notes: string | null
          risk_limits: string | null
          status: string
          submission_hash: string
          symbols: string | null
          target_venues: string | null
          timeframes: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          automation_level?: string | null
          company?: string | null
          contact_email: string
          contact_name: string
          created_at?: string
          delivery_needs?: string | null
          id?: string
          notes?: string | null
          risk_limits?: string | null
          status?: string
          submission_hash: string
          symbols?: string | null
          target_venues?: string | null
          timeframes?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          automation_level?: string | null
          company?: string | null
          contact_email?: string
          contact_name?: string
          created_at?: string
          delivery_needs?: string | null
          id?: string
          notes?: string | null
          risk_limits?: string | null
          status?: string
          submission_hash?: string
          symbols?: string | null
          target_venues?: string | null
          timeframes?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      invitation_redemptions: {
        Row: {
          community_id: string
          id: string
          invitation_id: string
          redeemed_at: string
          user_id: string
        }
        Insert: {
          community_id: string
          id?: string
          invitation_id: string
          redeemed_at?: string
          user_id: string
        }
        Update: {
          community_id?: string
          id?: string
          invitation_id?: string
          redeemed_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "invitation_redemptions_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "trading_communities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invitation_redemptions_invitation_id_fkey"
            columns: ["invitation_id"]
            isOneToOne: false
            referencedRelation: "community_invitations"
            referencedColumns: ["id"]
          },
        ]
      }
      kill_switches: {
        Row: {
          active: boolean
          connection_id: string | null
          id: string
          reason: string | null
          scope: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          active?: boolean
          connection_id?: string | null
          id?: string
          reason?: string | null
          scope: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          active?: boolean
          connection_id?: string | null
          id?: string
          reason?: string | null
          scope?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "kill_switches_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "active_bot_config"
            referencedColumns: ["connection_id"]
          },
          {
            foreignKeyName: "kill_switches_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      kill_switches_legacy: {
        Row: {
          active: boolean | null
          archived_at: string
          scope: string | null
          updated_at: string | null
        }
        Insert: {
          active?: boolean | null
          archived_at?: string
          scope?: string | null
          updated_at?: string | null
        }
        Update: {
          active?: boolean | null
          archived_at?: string
          scope?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      life_categories: {
        Row: {
          created_at: string
          icon: string | null
          id: string
          is_custom: boolean
          is_essential: boolean
          key: string
          label: string
          sort_order: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          icon?: string | null
          id?: string
          is_custom?: boolean
          is_essential?: boolean
          key: string
          label: string
          sort_order?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          icon?: string | null
          id?: string
          is_custom?: boolean
          is_essential?: boolean
          key?: string
          label?: string
          sort_order?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      life_obligation_history: {
        Row: {
          amount: number | null
          billing_period: string | null
          category_id: string | null
          detail: Json | null
          event: string
          id: string
          new_status: string | null
          obligation_id: string
          occurred_at: string
          old_status: string | null
          series_id: string | null
          user_id: string
        }
        Insert: {
          amount?: number | null
          billing_period?: string | null
          category_id?: string | null
          detail?: Json | null
          event: string
          id?: string
          new_status?: string | null
          obligation_id: string
          occurred_at?: string
          old_status?: string | null
          series_id?: string | null
          user_id: string
        }
        Update: {
          amount?: number | null
          billing_period?: string | null
          category_id?: string | null
          detail?: Json | null
          event?: string
          id?: string
          new_status?: string | null
          obligation_id?: string
          occurred_at?: string
          old_status?: string | null
          series_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "life_obligation_history_obligation_id_fkey"
            columns: ["obligation_id"]
            isOneToOne: false
            referencedRelation: "life_obligations"
            referencedColumns: ["id"]
          },
        ]
      }
      life_obligations: {
        Row: {
          amount: number
          archived_at: string | null
          billing_period: string | null
          category_id: string
          created_at: string
          currency: string
          due_date: string | null
          id: string
          is_essential: boolean
          kind: string
          legacy_item_id: string | null
          monthly_funding_target: number
          name: string
          notes: string | null
          paid_at: string | null
          recurrence: string | null
          reminder_schedule: Json | null
          series_id: string
          sort_order: number
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          amount?: number
          archived_at?: string | null
          billing_period?: string | null
          category_id: string
          created_at?: string
          currency?: string
          due_date?: string | null
          id?: string
          is_essential?: boolean
          kind?: string
          legacy_item_id?: string | null
          monthly_funding_target?: number
          name: string
          notes?: string | null
          paid_at?: string | null
          recurrence?: string | null
          reminder_schedule?: Json | null
          series_id?: string
          sort_order?: number
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          amount?: number
          archived_at?: string | null
          billing_period?: string | null
          category_id?: string
          created_at?: string
          currency?: string
          due_date?: string | null
          id?: string
          is_essential?: boolean
          kind?: string
          legacy_item_id?: string | null
          monthly_funding_target?: number
          name?: string
          notes?: string | null
          paid_at?: string | null
          recurrence?: string | null
          reminder_schedule?: Json | null
          series_id?: string
          sort_order?: number
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "life_obligations_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "life_categories"
            referencedColumns: ["id"]
          },
        ]
      }
      live_fills: {
        Row: {
          connection_id: string
          created_at: string
          fee: number
          fee_currency: string | null
          fill_ts: string
          id: string
          liquidity: string | null
          matched_at: string | null
          price: number
          raw: Json
          residual_size: number
          side: string
          size: number
          symbol: string
          user_id: string
          venue: string
          venue_fill_id: string
          venue_order_id: string | null
        }
        Insert: {
          connection_id: string
          created_at?: string
          fee?: number
          fee_currency?: string | null
          fill_ts: string
          id?: string
          liquidity?: string | null
          matched_at?: string | null
          price: number
          raw?: Json
          residual_size: number
          side: string
          size: number
          symbol: string
          user_id: string
          venue?: string
          venue_fill_id: string
          venue_order_id?: string | null
        }
        Update: {
          connection_id?: string
          created_at?: string
          fee?: number
          fee_currency?: string | null
          fill_ts?: string
          id?: string
          liquidity?: string | null
          matched_at?: string | null
          price?: number
          raw?: Json
          residual_size?: number
          side?: string
          size?: number
          symbol?: string
          user_id?: string
          venue?: string
          venue_fill_id?: string
          venue_order_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "live_fills_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "active_bot_config"
            referencedColumns: ["connection_id"]
          },
          {
            foreignKeyName: "live_fills_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      live_fills_cursor: {
        Row: {
          connection_id: string
          last_fill_id: string | null
          last_fill_ts: string | null
          last_polled_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          connection_id: string
          last_fill_id?: string | null
          last_fill_ts?: string | null
          last_polled_at?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          connection_id?: string
          last_fill_id?: string | null
          last_fill_ts?: string | null
          last_polled_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "live_fills_cursor_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: true
            referencedRelation: "active_bot_config"
            referencedColumns: ["connection_id"]
          },
          {
            foreignKeyName: "live_fills_cursor_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: true
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      live_position_advisories: {
        Row: {
          advisory: boolean
          candle_close_at: string
          consensus_action: string
          consensus_confidence: number | null
          created_at: string
          direction: string
          evidence_hash: string
          id: string
          narrative: string
          position_id: string
          risk_check: Json
          seats_available: number
          seats_total: number
          snapshot: Json
          symbol: string
          trace_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          advisory?: boolean
          candle_close_at: string
          consensus_action?: string
          consensus_confidence?: number | null
          created_at?: string
          direction: string
          evidence_hash: string
          id?: string
          narrative?: string
          position_id: string
          risk_check?: Json
          seats_available?: number
          seats_total?: number
          snapshot?: Json
          symbol: string
          trace_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          advisory?: boolean
          candle_close_at?: string
          consensus_action?: string
          consensus_confidence?: number | null
          created_at?: string
          direction?: string
          evidence_hash?: string
          id?: string
          narrative?: string
          position_id?: string
          risk_check?: Json
          seats_available?: number
          seats_total?: number
          snapshot?: Json
          symbol?: string
          trace_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      live_position_advisory_opinions: {
        Row: {
          action: string | null
          advisory_id: string
          available: boolean
          confidence: number | null
          created_at: string
          detail: string | null
          id: string
          latency_ms: number
          model: string
          provider: string
          rationale: string | null
          raw: Json
          risk_flags: Json
          role: string
          unavailable_reason: string | null
          user_id: string
        }
        Insert: {
          action?: string | null
          advisory_id: string
          available: boolean
          confidence?: number | null
          created_at?: string
          detail?: string | null
          id?: string
          latency_ms?: number
          model: string
          provider: string
          rationale?: string | null
          raw?: Json
          risk_flags?: Json
          role: string
          unavailable_reason?: string | null
          user_id: string
        }
        Update: {
          action?: string | null
          advisory_id?: string
          available?: boolean
          confidence?: number | null
          created_at?: string
          detail?: string | null
          id?: string
          latency_ms?: number
          model?: string
          provider?: string
          rationale?: string | null
          raw?: Json
          risk_flags?: Json
          role?: string
          unavailable_reason?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "live_position_advisory_opinions_advisory_id_fkey"
            columns: ["advisory_id"]
            isOneToOne: false
            referencedRelation: "live_position_advisories"
            referencedColumns: ["id"]
          },
        ]
      }
      live_recon_leases: {
        Row: {
          connection_id: string
          lease_until: string
          updated_at: string
        }
        Insert: {
          connection_id: string
          lease_until: string
          updated_at?: string
        }
        Update: {
          connection_id?: string
          lease_until?: string
          updated_at?: string
        }
        Relationships: []
      }
      live_tp_council_reviews: {
        Row: {
          candles_counted: number
          completed_at: string | null
          council_inputs: Json
          council_opinions: Json
          created_at: string
          decision: string | null
          decision_price: number | null
          decision_size: number | null
          degraded: boolean
          fill_ts: string
          final_state: string | null
          id: string
          intent_idempotency_key: string | null
          position_id: string
          rationale: string | null
          reject_reason: string | null
          review_key: string
          review_seq: number
          status: string
          timeframe: string
          user_id: string
          venue_order_id: string | null
        }
        Insert: {
          candles_counted?: number
          completed_at?: string | null
          council_inputs?: Json
          council_opinions?: Json
          created_at?: string
          decision?: string | null
          decision_price?: number | null
          decision_size?: number | null
          degraded?: boolean
          fill_ts: string
          final_state?: string | null
          id?: string
          intent_idempotency_key?: string | null
          position_id: string
          rationale?: string | null
          reject_reason?: string | null
          review_key: string
          review_seq: number
          status?: string
          timeframe: string
          user_id: string
          venue_order_id?: string | null
        }
        Update: {
          candles_counted?: number
          completed_at?: string | null
          council_inputs?: Json
          council_opinions?: Json
          created_at?: string
          decision?: string | null
          decision_price?: number | null
          decision_size?: number | null
          degraded?: boolean
          fill_ts?: string
          final_state?: string | null
          id?: string
          intent_idempotency_key?: string | null
          position_id?: string
          rationale?: string | null
          reject_reason?: string | null
          review_key?: string
          review_seq?: number
          status?: string
          timeframe?: string
          user_id?: string
          venue_order_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "live_tp_council_reviews_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
        ]
      }
      margin_policy_events: {
        Row: {
          created_at: string
          detail: Json
          event: string
          from_value: string | null
          id: string
          reason_code: string
          scope: string
          scope_id: string | null
          supersedes_event_id: string | null
          to_value: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          detail?: Json
          event: string
          from_value?: string | null
          id?: string
          reason_code: string
          scope: string
          scope_id?: string | null
          supersedes_event_id?: string | null
          to_value?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          detail?: Json
          event?: string
          from_value?: string | null
          id?: string
          reason_code?: string
          scope?: string
          scope_id?: string | null
          supersedes_event_id?: string | null
          to_value?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "margin_policy_events_supersedes_event_id_fkey"
            columns: ["supersedes_event_id"]
            isOneToOne: false
            referencedRelation: "margin_policy_events"
            referencedColumns: ["id"]
          },
        ]
      }
      milestone_definitions: {
        Row: {
          code: string
          created_at: string
          description: string | null
          is_repeatable: boolean
          label: string
          points: number
          scope: string
        }
        Insert: {
          code: string
          created_at?: string
          description?: string | null
          is_repeatable?: boolean
          label: string
          points: number
          scope?: string
        }
        Update: {
          code?: string
          created_at?: string
          description?: string | null
          is_repeatable?: boolean
          label?: string
          points?: number
          scope?: string
        }
        Relationships: []
      }
      onyx_decisions: {
        Row: {
          confidence: number | null
          conflicting_codes: string[]
          correlation_id: string
          created_at: string
          decision: string
          decision_at: string
          decision_latency_ms: number | null
          detail: Json
          envelope_version: number
          id: string
          intent_at: string | null
          reject_reason: string | null
          risk_check: Json
          rules_version: number
          scan_id: string | null
          side: string
          signal_at: string | null
          strategy: string | null
          supporting_codes: string[]
          symbol: string
          user_id: string
          wallet_id: string | null
        }
        Insert: {
          confidence?: number | null
          conflicting_codes?: string[]
          correlation_id: string
          created_at?: string
          decision: string
          decision_at?: string
          decision_latency_ms?: number | null
          detail?: Json
          envelope_version: number
          id?: string
          intent_at?: string | null
          reject_reason?: string | null
          risk_check?: Json
          rules_version: number
          scan_id?: string | null
          side: string
          signal_at?: string | null
          strategy?: string | null
          supporting_codes?: string[]
          symbol: string
          user_id: string
          wallet_id?: string | null
        }
        Update: {
          confidence?: number | null
          conflicting_codes?: string[]
          correlation_id?: string
          created_at?: string
          decision?: string
          decision_at?: string
          decision_latency_ms?: number | null
          detail?: Json
          envelope_version?: number
          id?: string
          intent_at?: string | null
          reject_reason?: string | null
          risk_check?: Json
          rules_version?: number
          scan_id?: string | null
          side?: string
          signal_at?: string | null
          strategy?: string | null
          supporting_codes?: string[]
          symbol?: string
          user_id?: string
          wallet_id?: string | null
        }
        Relationships: []
      }
      ops_events: {
        Row: {
          component: string
          correlation_id: string
          created_at: string
          detail: Json
          id: string
          latency_ms: number | null
          message: string
          server_ts: string
          severity: string
          stage: string
          user_id: string | null
        }
        Insert: {
          component: string
          correlation_id: string
          created_at?: string
          detail?: Json
          id?: string
          latency_ms?: number | null
          message: string
          server_ts?: string
          severity?: string
          stage: string
          user_id?: string | null
        }
        Update: {
          component?: string
          correlation_id?: string
          created_at?: string
          detail?: Json
          id?: string
          latency_ms?: number | null
          message?: string
          server_ts?: string
          severity?: string
          stage?: string
          user_id?: string | null
        }
        Relationships: []
      }
      ops_health_snapshots: {
        Row: {
          backlog_count: number
          component: string
          created_at: string
          detail: Json
          freshness_ms: number | null
          id: string
          last_success_at: string | null
          p50_latency_ms: number | null
          p95_latency_ms: number | null
          reasons: Json
          server_ts: string
          state: string
          user_id: string | null
        }
        Insert: {
          backlog_count?: number
          component: string
          created_at?: string
          detail?: Json
          freshness_ms?: number | null
          id?: string
          last_success_at?: string | null
          p50_latency_ms?: number | null
          p95_latency_ms?: number | null
          reasons?: Json
          server_ts?: string
          state: string
          user_id?: string | null
        }
        Update: {
          backlog_count?: number
          component?: string
          created_at?: string
          detail?: Json
          freshness_ms?: number | null
          id?: string
          last_success_at?: string | null
          p50_latency_ms?: number | null
          p95_latency_ms?: number | null
          reasons?: Json
          server_ts?: string
          state?: string
          user_id?: string | null
        }
        Relationships: []
      }
      order_audit: {
        Row: {
          connection_id: string | null
          created_at: string
          exchange_order_id: string | null
          exchange_status: string | null
          id: string
          idempotency_key: string | null
          is_live: boolean | null
          leverage: number | null
          order_type: string | null
          phase: string
          price: number | null
          reject_reason: string | null
          sanitized_response: Json | null
          side: string | null
          size: number | null
          symbol: string | null
          user_id: string | null
          venue: string | null
        }
        Insert: {
          connection_id?: string | null
          created_at?: string
          exchange_order_id?: string | null
          exchange_status?: string | null
          id?: string
          idempotency_key?: string | null
          is_live?: boolean | null
          leverage?: number | null
          order_type?: string | null
          phase: string
          price?: number | null
          reject_reason?: string | null
          sanitized_response?: Json | null
          side?: string | null
          size?: number | null
          symbol?: string | null
          user_id?: string | null
          venue?: string | null
        }
        Update: {
          connection_id?: string | null
          created_at?: string
          exchange_order_id?: string | null
          exchange_status?: string | null
          id?: string
          idempotency_key?: string | null
          is_live?: boolean | null
          leverage?: number | null
          order_type?: string | null
          phase?: string
          price?: number | null
          reject_reason?: string | null
          sanitized_response?: Json | null
          side?: string | null
          size?: number | null
          symbol?: string | null
          user_id?: string | null
          venue?: string | null
        }
        Relationships: []
      }
      order_intents: {
        Row: {
          avg_fill_price: number | null
          client_order_id: string
          connection_id: string
          created_at: string
          environment: string
          exchange_order_id: string | null
          exchange_status: string | null
          expires_at: string | null
          filled_size: number
          id: string
          last_reconciled_at: string | null
          margin_mode: string | null
          mark_price_at_preview: number | null
          max_fee: number | null
          order_type: string
          protected_price: number | null
          reduce_only: boolean
          side: string
          size: number
          slippage_bps: number | null
          state: Database["public"]["Enums"]["order_intent_state"]
          state_reason: string | null
          symbol: string
          updated_at: string
          user_id: string
          venue: string
          wallet_address: string | null
        }
        Insert: {
          avg_fill_price?: number | null
          client_order_id: string
          connection_id: string
          created_at?: string
          environment: string
          exchange_order_id?: string | null
          exchange_status?: string | null
          expires_at?: string | null
          filled_size?: number
          id?: string
          last_reconciled_at?: string | null
          margin_mode?: string | null
          mark_price_at_preview?: number | null
          max_fee?: number | null
          order_type: string
          protected_price?: number | null
          reduce_only?: boolean
          side: string
          size: number
          slippage_bps?: number | null
          state?: Database["public"]["Enums"]["order_intent_state"]
          state_reason?: string | null
          symbol: string
          updated_at?: string
          user_id: string
          venue: string
          wallet_address?: string | null
        }
        Update: {
          avg_fill_price?: number | null
          client_order_id?: string
          connection_id?: string
          created_at?: string
          environment?: string
          exchange_order_id?: string | null
          exchange_status?: string | null
          expires_at?: string | null
          filled_size?: number
          id?: string
          last_reconciled_at?: string | null
          margin_mode?: string | null
          mark_price_at_preview?: number | null
          max_fee?: number | null
          order_type?: string
          protected_price?: number | null
          reduce_only?: boolean
          side?: string
          size?: number
          slippage_bps?: number | null
          state?: Database["public"]["Enums"]["order_intent_state"]
          state_reason?: string | null
          symbol?: string
          updated_at?: string
          user_id?: string
          venue?: string
          wallet_address?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "order_intents_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "active_bot_config"
            referencedColumns: ["connection_id"]
          },
          {
            foreignKeyName: "order_intents_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          avg_price: number | null
          client_order_id: string
          connection_id: string | null
          created_at: string
          exchange_order_id: string | null
          fee: number | null
          filled_size: number
          id: string
          leverage: number | null
          mode: string
          position_side: string | null
          requested_size: number
          resolved_max_leverage: number | null
          side: string
          status: string
          strategy: string
          symbol: string
          updated_at: string
          user_id: string
          venue: string | null
        }
        Insert: {
          avg_price?: number | null
          client_order_id: string
          connection_id?: string | null
          created_at?: string
          exchange_order_id?: string | null
          fee?: number | null
          filled_size?: number
          id?: string
          leverage?: number | null
          mode?: string
          position_side?: string | null
          requested_size: number
          resolved_max_leverage?: number | null
          side: string
          status?: string
          strategy: string
          symbol: string
          updated_at?: string
          user_id: string
          venue?: string | null
        }
        Update: {
          avg_price?: number | null
          client_order_id?: string
          connection_id?: string | null
          created_at?: string
          exchange_order_id?: string | null
          fee?: number | null
          filled_size?: number
          id?: string
          leverage?: number | null
          mode?: string
          position_side?: string | null
          requested_size?: number
          resolved_max_leverage?: number | null
          side?: string
          status?: string
          strategy?: string
          symbol?: string
          updated_at?: string
          user_id?: string
          venue?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "orders_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "active_bot_config"
            referencedColumns: ["connection_id"]
          },
          {
            foreignKeyName: "orders_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      paper_accounts: {
        Row: {
          balance: number
          created_at: string
          realized_pnl: number
          updated_at: string
          user_id: string
        }
        Insert: {
          balance?: number
          created_at?: string
          realized_pnl?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          balance?: number
          created_at?: string
          realized_pnl?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      paper_ai_opinions: {
        Row: {
          advisory: boolean
          confidence: number | null
          created_at: string
          direction: string | null
          id: string
          latency_ms: number | null
          model: string
          prompt_version: string | null
          provider: string
          risk_flags: string[]
          role: string
          status: string
          summary: string | null
          trace_id: string
          unavailable_reason: string | null
          user_id: string
        }
        Insert: {
          advisory?: boolean
          confidence?: number | null
          created_at?: string
          direction?: string | null
          id?: string
          latency_ms?: number | null
          model: string
          prompt_version?: string | null
          provider: string
          risk_flags?: string[]
          role: string
          status: string
          summary?: string | null
          trace_id: string
          unavailable_reason?: string | null
          user_id: string
        }
        Update: {
          advisory?: boolean
          confidence?: number | null
          created_at?: string
          direction?: string | null
          id?: string
          latency_ms?: number | null
          model?: string
          prompt_version?: string | null
          provider?: string
          risk_flags?: string[]
          role?: string
          status?: string
          summary?: string | null
          trace_id?: string
          unavailable_reason?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "paper_ai_opinions_trace_id_fkey"
            columns: ["trace_id"]
            isOneToOne: false
            referencedRelation: "paper_ai_orchestrations"
            referencedColumns: ["trace_id"]
          },
        ]
      }
      paper_ai_orchestrations: {
        Row: {
          candidate_key: string
          candle_ts_ms: number
          committee_verdict: string | null
          corrected_at: string | null
          correction_reason: string | null
          created_at: string
          degraded: boolean
          degraded_reason: string | null
          direction: string
          evidence: Json
          evidence_hash: string
          gate_allowed: boolean
          onyx_confidence: number | null
          onyx_decision: string
          onyx_decision_id: string | null
          onyx_rationale: string
          paper_position_id: string | null
          paper_trade_id: string | null
          participation: string
          prompt_version: string | null
          providers_answered: number
          providers_attempted: number
          record_kind: string
          risk_checked: boolean
          risk_code: string | null
          risk_detail: Json | null
          risk_passed: boolean
          snapshot_detail: Json | null
          snapshot_invalid_code: string | null
          snapshot_valid: boolean
          strategy: string
          symbol: string
          terminal_outcome: string
          timeframe: string
          trace_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          candidate_key: string
          candle_ts_ms?: number
          committee_verdict?: string | null
          corrected_at?: string | null
          correction_reason?: string | null
          created_at?: string
          degraded?: boolean
          degraded_reason?: string | null
          direction: string
          evidence?: Json
          evidence_hash: string
          gate_allowed?: boolean
          onyx_confidence?: number | null
          onyx_decision?: string
          onyx_decision_id?: string | null
          onyx_rationale?: string
          paper_position_id?: string | null
          paper_trade_id?: string | null
          participation?: string
          prompt_version?: string | null
          providers_answered?: number
          providers_attempted?: number
          record_kind?: string
          risk_checked?: boolean
          risk_code?: string | null
          risk_detail?: Json | null
          risk_passed?: boolean
          snapshot_detail?: Json | null
          snapshot_invalid_code?: string | null
          snapshot_valid?: boolean
          strategy: string
          symbol: string
          terminal_outcome?: string
          timeframe?: string
          trace_id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          candidate_key?: string
          candle_ts_ms?: number
          committee_verdict?: string | null
          corrected_at?: string | null
          correction_reason?: string | null
          created_at?: string
          degraded?: boolean
          degraded_reason?: string | null
          direction?: string
          evidence?: Json
          evidence_hash?: string
          gate_allowed?: boolean
          onyx_confidence?: number | null
          onyx_decision?: string
          onyx_decision_id?: string | null
          onyx_rationale?: string
          paper_position_id?: string | null
          paper_trade_id?: string | null
          participation?: string
          prompt_version?: string | null
          providers_answered?: number
          providers_attempted?: number
          record_kind?: string
          risk_checked?: boolean
          risk_code?: string | null
          risk_detail?: Json | null
          risk_passed?: boolean
          snapshot_detail?: Json | null
          snapshot_invalid_code?: string | null
          snapshot_valid?: boolean
          strategy?: string
          symbol?: string
          terminal_outcome?: string
          timeframe?: string
          trace_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      paper_authorizations: {
        Row: {
          approved_leverage: number
          approved_margin: number
          approved_margin_mode: string
          approved_notional: number
          connection_id: string | null
          consumed_at: string | null
          consumed_position_id: string | null
          consumed_slot_id: string | null
          correlation_id: string
          created_at: string
          detail: Json
          direction: string
          envelope_version: number | null
          environment: Database["public"]["Enums"]["scout_environment"]
          epoch_id: string | null
          exchange: string
          expires_at: string
          formation: string
          id: string
          issued_at: string
          leg_id: string | null
          market_type: Database["public"]["Enums"]["scout_market_type"]
          onyx_decision_id: string
          pod_id: string | null
          purpose: string | null
          ranking_snapshot_id: string
          ranking_version: number
          rules_version: number | null
          run_id: string
          scan_id: string
          signal_id: string | null
          symbol: string
          universe_version: number
          updated_at: string
          user_id: string
        }
        Insert: {
          approved_leverage: number
          approved_margin: number
          approved_margin_mode: string
          approved_notional: number
          connection_id?: string | null
          consumed_at?: string | null
          consumed_position_id?: string | null
          consumed_slot_id?: string | null
          correlation_id?: string
          created_at?: string
          detail?: Json
          direction: string
          envelope_version?: number | null
          environment: Database["public"]["Enums"]["scout_environment"]
          epoch_id?: string | null
          exchange: string
          expires_at: string
          formation: string
          id?: string
          issued_at?: string
          leg_id?: string | null
          market_type: Database["public"]["Enums"]["scout_market_type"]
          onyx_decision_id: string
          pod_id?: string | null
          purpose?: string | null
          ranking_snapshot_id: string
          ranking_version: number
          rules_version?: number | null
          run_id: string
          scan_id: string
          signal_id?: string | null
          symbol: string
          universe_version: number
          updated_at?: string
          user_id: string
        }
        Update: {
          approved_leverage?: number
          approved_margin?: number
          approved_margin_mode?: string
          approved_notional?: number
          connection_id?: string | null
          consumed_at?: string | null
          consumed_position_id?: string | null
          consumed_slot_id?: string | null
          correlation_id?: string
          created_at?: string
          detail?: Json
          direction?: string
          envelope_version?: number | null
          environment?: Database["public"]["Enums"]["scout_environment"]
          epoch_id?: string | null
          exchange?: string
          expires_at?: string
          formation?: string
          id?: string
          issued_at?: string
          leg_id?: string | null
          market_type?: Database["public"]["Enums"]["scout_market_type"]
          onyx_decision_id?: string
          pod_id?: string | null
          purpose?: string | null
          ranking_snapshot_id?: string
          ranking_version?: number
          rules_version?: number | null
          run_id?: string
          scan_id?: string
          signal_id?: string | null
          symbol?: string
          universe_version?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "paper_authorizations_epoch_id_fkey"
            columns: ["epoch_id"]
            isOneToOne: false
            referencedRelation: "paper_epochs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "paper_authorizations_leg_id_fkey"
            columns: ["leg_id"]
            isOneToOne: false
            referencedRelation: "paper_wallet_legs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "paper_authorizations_onyx_decision_id_fkey"
            columns: ["onyx_decision_id"]
            isOneToOne: true
            referencedRelation: "onyx_decisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "paper_authorizations_pod_id_fkey"
            columns: ["pod_id"]
            isOneToOne: false
            referencedRelation: "paper_symbol_pods"
            referencedColumns: ["id"]
          },
        ]
      }
      paper_engine_authority: {
        Row: {
          enabled_at: string
          mode: string
          notes: string | null
          user_id: string
        }
        Insert: {
          enabled_at?: string
          mode?: string
          notes?: string | null
          user_id: string
        }
        Update: {
          enabled_at?: string
          mode?: string
          notes?: string | null
          user_id?: string
        }
        Relationships: []
      }
      paper_engine_operations: {
        Row: {
          claimed_at: string
          completed_at: string | null
          created_at: string
          fingerprint: string
          id: string
          op_key: string
          recovered_at: string | null
          recovery_reason: string | null
          result: Json | null
          state: string
          updated_at: string
          user_id: string
        }
        Insert: {
          claimed_at?: string
          completed_at?: string | null
          created_at?: string
          fingerprint: string
          id?: string
          op_key: string
          recovered_at?: string | null
          recovery_reason?: string | null
          result?: Json | null
          state?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          claimed_at?: string
          completed_at?: string | null
          created_at?: string
          fingerprint?: string
          id?: string
          op_key?: string
          recovered_at?: string | null
          recovery_reason?: string | null
          result?: Json | null
          state?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      paper_epochs: {
        Row: {
          completed_at: string | null
          created_at: string
          id: string
          reason: string
          reconciled_counts: Json
          run_id: string
          started_at: string
          status: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          id?: string
          reason: string
          reconciled_counts?: Json
          run_id: string
          started_at?: string
          status?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          id?: string
          reason?: string
          reconciled_counts?: Json
          run_id?: string
          started_at?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      paper_execution_slot_audit: {
        Row: {
          correlation_id: string | null
          created_at: string
          detail: Json
          event: string
          id: string
          new_state: Database["public"]["Enums"]["paper_slot_state"] | null
          new_symbol: string | null
          old_state: Database["public"]["Enums"]["paper_slot_state"] | null
          old_symbol: string | null
          slot_id: string
          user_id: string
        }
        Insert: {
          correlation_id?: string | null
          created_at?: string
          detail?: Json
          event: string
          id?: string
          new_state?: Database["public"]["Enums"]["paper_slot_state"] | null
          new_symbol?: string | null
          old_state?: Database["public"]["Enums"]["paper_slot_state"] | null
          old_symbol?: string | null
          slot_id: string
          user_id: string
        }
        Update: {
          correlation_id?: string | null
          created_at?: string
          detail?: Json
          event?: string
          id?: string
          new_state?: Database["public"]["Enums"]["paper_slot_state"] | null
          new_symbol?: string | null
          old_state?: Database["public"]["Enums"]["paper_slot_state"] | null
          old_symbol?: string | null
          slot_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "paper_execution_slot_audit_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "paper_execution_slots"
            referencedColumns: ["id"]
          },
        ]
      }
      paper_execution_slots: {
        Row: {
          assigned_direction: string | null
          assigned_symbol: string | null
          authorization_id: string | null
          capacity_version: number
          connection_id: string | null
          correlation_id: string | null
          created_at: string
          detail: Json
          environment: Database["public"]["Enums"]["scout_environment"]
          exchange: string
          id: string
          last_transition_at: string | null
          market_type: Database["public"]["Enums"]["scout_market_type"]
          position_id: string | null
          reservation_expires_at: string | null
          slot_index: number
          state: Database["public"]["Enums"]["paper_slot_state"]
          updated_at: string
          user_id: string
        }
        Insert: {
          assigned_direction?: string | null
          assigned_symbol?: string | null
          authorization_id?: string | null
          capacity_version?: number
          connection_id?: string | null
          correlation_id?: string | null
          created_at?: string
          detail?: Json
          environment: Database["public"]["Enums"]["scout_environment"]
          exchange: string
          id?: string
          last_transition_at?: string | null
          market_type: Database["public"]["Enums"]["scout_market_type"]
          position_id?: string | null
          reservation_expires_at?: string | null
          slot_index: number
          state?: Database["public"]["Enums"]["paper_slot_state"]
          updated_at?: string
          user_id: string
        }
        Update: {
          assigned_direction?: string | null
          assigned_symbol?: string | null
          authorization_id?: string | null
          capacity_version?: number
          connection_id?: string | null
          correlation_id?: string | null
          created_at?: string
          detail?: Json
          environment?: Database["public"]["Enums"]["scout_environment"]
          exchange?: string
          id?: string
          last_transition_at?: string | null
          market_type?: Database["public"]["Enums"]["scout_market_type"]
          position_id?: string | null
          reservation_expires_at?: string | null
          slot_index?: number
          state?: Database["public"]["Enums"]["paper_slot_state"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "paper_execution_slots_authorization_id_fkey"
            columns: ["authorization_id"]
            isOneToOne: false
            referencedRelation: "paper_authorizations"
            referencedColumns: ["id"]
          },
        ]
      }
      paper_live_shadow_ledger: {
        Row: {
          comparison_status: string
          direction: string
          directive_type: string
          divergence_reason: string | null
          id: string
          leg: string
          live_decision: Json | null
          live_price: number | null
          notes: Json
          observed_at: string
          paper_decision: Json
          paper_price: number | null
          price_delta_bps: number | null
          regime: string | null
          symbol: string
          trend_age_candles: number | null
          user_id: string
        }
        Insert: {
          comparison_status?: string
          direction: string
          directive_type: string
          divergence_reason?: string | null
          id?: string
          leg: string
          live_decision?: Json | null
          live_price?: number | null
          notes?: Json
          observed_at?: string
          paper_decision: Json
          paper_price?: number | null
          price_delta_bps?: number | null
          regime?: string | null
          symbol: string
          trend_age_candles?: number | null
          user_id: string
        }
        Update: {
          comparison_status?: string
          direction?: string
          directive_type?: string
          divergence_reason?: string | null
          id?: string
          leg?: string
          live_decision?: Json | null
          live_price?: number | null
          notes?: Json
          observed_at?: string
          paper_decision?: Json
          paper_price?: number | null
          price_delta_bps?: number | null
          regime?: string | null
          symbol?: string
          trend_age_candles?: number | null
          user_id?: string
        }
        Relationships: []
      }
      paper_order_intents: {
        Row: {
          created_at: string
          epoch_id: string | null
          evidence: Json
          id: string
          leverage: number
          margin: number
          notional: number
          onyx_decision_id: string | null
          ranking_snapshot_id: string | null
          reason_code: string
          reason_detail: string
          run_id: string | null
          scan_id: string | null
          side: string
          state: string
          strategy: string | null
          symbol: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          epoch_id?: string | null
          evidence?: Json
          id?: string
          leverage?: number
          margin?: number
          notional?: number
          onyx_decision_id?: string | null
          ranking_snapshot_id?: string | null
          reason_code: string
          reason_detail?: string
          run_id?: string | null
          scan_id?: string | null
          side: string
          state: string
          strategy?: string | null
          symbol: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          epoch_id?: string | null
          evidence?: Json
          id?: string
          leverage?: number
          margin?: number
          notional?: number
          onyx_decision_id?: string | null
          ranking_snapshot_id?: string | null
          reason_code?: string
          reason_detail?: string
          run_id?: string | null
          scan_id?: string | null
          side?: string
          state?: string
          strategy?: string | null
          symbol?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "paper_order_intents_epoch_id_fkey"
            columns: ["epoch_id"]
            isOneToOne: false
            referencedRelation: "paper_epochs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "paper_order_intents_onyx_decision_id_fkey"
            columns: ["onyx_decision_id"]
            isOneToOne: false
            referencedRelation: "onyx_decisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "paper_order_intents_ranking_snapshot_id_fkey"
            columns: ["ranking_snapshot_id"]
            isOneToOne: false
            referencedRelation: "scout_universe_snapshots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "paper_order_intents_scan_id_fkey"
            columns: ["scan_id"]
            isOneToOne: false
            referencedRelation: "scout_scans"
            referencedColumns: ["id"]
          },
        ]
      }
      paper_position_event_opinions: {
        Row: {
          advisory: boolean
          confidence: number | null
          created_at: string
          direction: string | null
          event_id: string
          id: string
          latency_ms: number | null
          model: string
          prompt_version: string | null
          provider: string
          risk_flags: string[]
          role: string
          status: string
          summary: string | null
          unavailable_reason: string | null
          user_id: string
        }
        Insert: {
          advisory?: boolean
          confidence?: number | null
          created_at?: string
          direction?: string | null
          event_id: string
          id?: string
          latency_ms?: number | null
          model: string
          prompt_version?: string | null
          provider: string
          risk_flags?: string[]
          role: string
          status: string
          summary?: string | null
          unavailable_reason?: string | null
          user_id: string
        }
        Update: {
          advisory?: boolean
          confidence?: number | null
          created_at?: string
          direction?: string | null
          event_id?: string
          id?: string
          latency_ms?: number | null
          model?: string
          prompt_version?: string | null
          provider?: string
          risk_flags?: string[]
          role?: string
          status?: string
          summary?: string | null
          unavailable_reason?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "paper_position_event_opinions_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "paper_position_events"
            referencedColumns: ["id"]
          },
        ]
      }
      paper_position_events: {
        Row: {
          action_applied: boolean
          apply_blocked_reason: string | null
          created_at: string
          degraded: boolean
          degraded_reason: string | null
          direction: string
          entry_attribution: string
          event_kind: string
          evidence: Json
          evidence_hash: string
          id: string
          management_root_trace_id: string | null
          onyx_action: string
          onyx_confidence: number | null
          onyx_rationale: string
          paper_position_id: string
          parent_trace_id: string | null
          participation: string
          providers_answered: number
          providers_attempted: number
          risk_checked: boolean
          risk_code: string | null
          risk_detail: Json | null
          risk_passed: boolean
          sequence: number
          symbol: string
          trace_id: string
          trigger: string
          user_id: string
        }
        Insert: {
          action_applied?: boolean
          apply_blocked_reason?: string | null
          created_at?: string
          degraded?: boolean
          degraded_reason?: string | null
          direction: string
          entry_attribution?: string
          event_kind?: string
          evidence?: Json
          evidence_hash: string
          id?: string
          management_root_trace_id?: string | null
          onyx_action?: string
          onyx_confidence?: number | null
          onyx_rationale?: string
          paper_position_id: string
          parent_trace_id?: string | null
          participation?: string
          providers_answered?: number
          providers_attempted?: number
          risk_checked?: boolean
          risk_code?: string | null
          risk_detail?: Json | null
          risk_passed?: boolean
          sequence?: number
          symbol: string
          trace_id: string
          trigger: string
          user_id: string
        }
        Update: {
          action_applied?: boolean
          apply_blocked_reason?: string | null
          created_at?: string
          degraded?: boolean
          degraded_reason?: string | null
          direction?: string
          entry_attribution?: string
          event_kind?: string
          evidence?: Json
          evidence_hash?: string
          id?: string
          management_root_trace_id?: string | null
          onyx_action?: string
          onyx_confidence?: number | null
          onyx_rationale?: string
          paper_position_id?: string
          parent_trace_id?: string | null
          participation?: string
          providers_answered?: number
          providers_attempted?: number
          risk_checked?: boolean
          risk_code?: string | null
          risk_detail?: Json | null
          risk_passed?: boolean
          sequence?: number
          symbol?: string
          trace_id?: string
          trigger?: string
          user_id?: string
        }
        Relationships: []
      }
      paper_positions: {
        Row: {
          armed_reason: string | null
          armed_stop_price: number | null
          authorization_id: string | null
          banked_pnl_net: number | null
          banked_qty: number | null
          capability_reconciliation_required: boolean
          configured_rung_count: number | null
          created_at: string
          direction: string
          entry_candle_ts_ms: number
          entry_fee: number
          entry_price: number
          entry_ts: string
          filled_rung_count: number
          fills: Json
          final_rung_fill_price: number | null
          first_fill_vwap: number | null
          hard_stop_armed_at: string | null
          id: string
          ladder_contract_version: number | null
          ladder_total_margin: number | null
          ladder_total_notional: number | null
          ladder_total_rungs: number | null
          last_seen_candle_ts_ms: number | null
          leg_id: string | null
          leverage: number
          margin: number
          onyx_decision_id: string | null
          onyx_rationale: string | null
          opened_from_signal: string | null
          opened_margin_mode: string
          orchestration_trace_id: string | null
          pending_rungs: Json
          pod_id: string | null
          promoted: boolean
          promoted_at: string | null
          protective_swing_kind: string | null
          protective_swing_level: number | null
          regime_at_entry: string | null
          resize_levels: Json
          rung_count: number
          runner_breakeven_stop: number | null
          size_notional: number
          size_qty: number
          slot_id: string | null
          status: string
          stop_level: number | null
          strategy: string
          strategy_metadata: Json
          structure_broken: boolean
          structure_broken_level: number | null
          structure_broken_ts_ms: number | null
          symbol: string
          tp_level: number | null
          tp_tiers: Json | null
          trend_at_entry: string | null
          trend_slope_pct_at_entry: number | null
          updated_at: string
          user_id: string
          wallet_key: string
          zone_level: number
          zone_lower: number
          zone_upper: number
        }
        Insert: {
          armed_reason?: string | null
          armed_stop_price?: number | null
          authorization_id?: string | null
          banked_pnl_net?: number | null
          banked_qty?: number | null
          capability_reconciliation_required?: boolean
          configured_rung_count?: number | null
          created_at?: string
          direction: string
          entry_candle_ts_ms: number
          entry_fee?: number
          entry_price: number
          entry_ts: string
          filled_rung_count?: number
          fills?: Json
          final_rung_fill_price?: number | null
          first_fill_vwap?: number | null
          hard_stop_armed_at?: string | null
          id?: string
          ladder_contract_version?: number | null
          ladder_total_margin?: number | null
          ladder_total_notional?: number | null
          ladder_total_rungs?: number | null
          last_seen_candle_ts_ms?: number | null
          leg_id?: string | null
          leverage: number
          margin: number
          onyx_decision_id?: string | null
          onyx_rationale?: string | null
          opened_from_signal?: string | null
          opened_margin_mode?: string
          orchestration_trace_id?: string | null
          pending_rungs?: Json
          pod_id?: string | null
          promoted?: boolean
          promoted_at?: string | null
          protective_swing_kind?: string | null
          protective_swing_level?: number | null
          regime_at_entry?: string | null
          resize_levels?: Json
          rung_count?: number
          runner_breakeven_stop?: number | null
          size_notional: number
          size_qty: number
          slot_id?: string | null
          status?: string
          stop_level?: number | null
          strategy?: string
          strategy_metadata?: Json
          structure_broken?: boolean
          structure_broken_level?: number | null
          structure_broken_ts_ms?: number | null
          symbol: string
          tp_level?: number | null
          tp_tiers?: Json | null
          trend_at_entry?: string | null
          trend_slope_pct_at_entry?: number | null
          updated_at?: string
          user_id: string
          wallet_key: string
          zone_level: number
          zone_lower: number
          zone_upper: number
        }
        Update: {
          armed_reason?: string | null
          armed_stop_price?: number | null
          authorization_id?: string | null
          banked_pnl_net?: number | null
          banked_qty?: number | null
          capability_reconciliation_required?: boolean
          configured_rung_count?: number | null
          created_at?: string
          direction?: string
          entry_candle_ts_ms?: number
          entry_fee?: number
          entry_price?: number
          entry_ts?: string
          filled_rung_count?: number
          fills?: Json
          final_rung_fill_price?: number | null
          first_fill_vwap?: number | null
          hard_stop_armed_at?: string | null
          id?: string
          ladder_contract_version?: number | null
          ladder_total_margin?: number | null
          ladder_total_notional?: number | null
          ladder_total_rungs?: number | null
          last_seen_candle_ts_ms?: number | null
          leg_id?: string | null
          leverage?: number
          margin?: number
          onyx_decision_id?: string | null
          onyx_rationale?: string | null
          opened_from_signal?: string | null
          opened_margin_mode?: string
          orchestration_trace_id?: string | null
          pending_rungs?: Json
          pod_id?: string | null
          promoted?: boolean
          promoted_at?: string | null
          protective_swing_kind?: string | null
          protective_swing_level?: number | null
          regime_at_entry?: string | null
          resize_levels?: Json
          rung_count?: number
          runner_breakeven_stop?: number | null
          size_notional?: number
          size_qty?: number
          slot_id?: string | null
          status?: string
          stop_level?: number | null
          strategy?: string
          strategy_metadata?: Json
          structure_broken?: boolean
          structure_broken_level?: number | null
          structure_broken_ts_ms?: number | null
          symbol?: string
          tp_level?: number | null
          tp_tiers?: Json | null
          trend_at_entry?: string | null
          trend_slope_pct_at_entry?: number | null
          updated_at?: string
          user_id?: string
          wallet_key?: string
          zone_level?: number
          zone_lower?: number
          zone_upper?: number
        }
        Relationships: [
          {
            foreignKeyName: "paper_positions_authorization_id_fkey"
            columns: ["authorization_id"]
            isOneToOne: false
            referencedRelation: "paper_authorizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "paper_positions_leg_id_fkey"
            columns: ["leg_id"]
            isOneToOne: false
            referencedRelation: "paper_wallet_legs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "paper_positions_pod_id_fkey"
            columns: ["pod_id"]
            isOneToOne: false
            referencedRelation: "paper_symbol_pods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "paper_positions_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "paper_execution_slots"
            referencedColumns: ["id"]
          },
        ]
      }
      paper_rung_fills: {
        Row: {
          candle_ts_ms: number | null
          fill_price: number
          fill_status: string
          filled_at: string
          id: string
          margin: number
          position_id: string
          qty: number
          rung_index: number
          tp_price: number
          user_id: string
        }
        Insert: {
          candle_ts_ms?: number | null
          fill_price: number
          fill_status?: string
          filled_at?: string
          id?: string
          margin?: number
          position_id: string
          qty: number
          rung_index: number
          tp_price?: number
          user_id: string
        }
        Update: {
          candle_ts_ms?: number | null
          fill_price?: number
          fill_status?: string
          filled_at?: string
          id?: string
          margin?: number
          position_id?: string
          qty?: number
          rung_index?: number
          tp_price?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "paper_rung_fills_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "paper_positions"
            referencedColumns: ["id"]
          },
        ]
      }
      paper_symbol_pods: {
        Row: {
          assigned_symbol: string | null
          bound_at: string | null
          bound_authorization_id: string | null
          capacity_version: number
          connection_id: string | null
          created_at: string
          detail: Json
          environment: Database["public"]["Enums"]["scout_environment"]
          exchange: string
          id: string
          market_type: Database["public"]["Enums"]["scout_market_type"]
          pod_index: number
          ranking_snapshot_id: string | null
          risk_budget_margin: number | null
          risk_budget_notional: number | null
          run_id: string
          state: string
          updated_at: string
          user_id: string
        }
        Insert: {
          assigned_symbol?: string | null
          bound_at?: string | null
          bound_authorization_id?: string | null
          capacity_version?: number
          connection_id?: string | null
          created_at?: string
          detail?: Json
          environment: Database["public"]["Enums"]["scout_environment"]
          exchange: string
          id?: string
          market_type: Database["public"]["Enums"]["scout_market_type"]
          pod_index: number
          ranking_snapshot_id?: string | null
          risk_budget_margin?: number | null
          risk_budget_notional?: number | null
          run_id: string
          state?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          assigned_symbol?: string | null
          bound_at?: string | null
          bound_authorization_id?: string | null
          capacity_version?: number
          connection_id?: string | null
          created_at?: string
          detail?: Json
          environment?: Database["public"]["Enums"]["scout_environment"]
          exchange?: string
          id?: string
          market_type?: Database["public"]["Enums"]["scout_market_type"]
          pod_index?: number
          ranking_snapshot_id?: string | null
          risk_budget_margin?: number | null
          risk_budget_notional?: number | null
          run_id?: string
          state?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      paper_test_symbols: {
        Row: {
          added_at: string
          created_at: string
          display_name: string
          enabled: boolean
          exchange: string
          id: string
          market_available: boolean
          max_leverage: number
          min_order_size: number | null
          notes: string | null
          sort_order: number
          step_size: number | null
          symbol: string
          tick_size: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          added_at?: string
          created_at?: string
          display_name: string
          enabled?: boolean
          exchange?: string
          id?: string
          market_available?: boolean
          max_leverage?: number
          min_order_size?: number | null
          notes?: string | null
          sort_order?: number
          step_size?: number | null
          symbol: string
          tick_size?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          added_at?: string
          created_at?: string
          display_name?: string
          enabled?: boolean
          exchange?: string
          id?: string
          market_available?: boolean
          max_leverage?: number
          min_order_size?: number | null
          notes?: string | null
          sort_order?: number
          step_size?: number | null
          symbol?: string
          tick_size?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      paper_tick_leases: {
        Row: {
          claimed_at: string
          claimed_by: string
          minute_bucket: string
          user_id: string
        }
        Insert: {
          claimed_at?: string
          claimed_by: string
          minute_bucket: string
          user_id: string
        }
        Update: {
          claimed_at?: string
          claimed_by?: string
          minute_bucket?: string
          user_id?: string
        }
        Relationships: []
      }
      paper_trade_reviews: {
        Row: {
          closed_at: string | null
          created_at: string
          direction: string
          exit_reason: string | null
          fees: number
          hold_seconds: number | null
          id: string
          management_actions: number
          model_attribution: Json
          onyx_correct: boolean | null
          onyx_decision: string | null
          outcome: string
          paper_trade_id: string
          participation: string | null
          pnl_gross: number
          pnl_net: number
          r_multiple: number | null
          regime: string | null
          scout_rank: number | null
          strategy: string | null
          symbol: string
          trace_id: string | null
          unattributed: boolean
          user_id: string
        }
        Insert: {
          closed_at?: string | null
          created_at?: string
          direction: string
          exit_reason?: string | null
          fees?: number
          hold_seconds?: number | null
          id?: string
          management_actions?: number
          model_attribution?: Json
          onyx_correct?: boolean | null
          onyx_decision?: string | null
          outcome: string
          paper_trade_id: string
          participation?: string | null
          pnl_gross?: number
          pnl_net?: number
          r_multiple?: number | null
          regime?: string | null
          scout_rank?: number | null
          strategy?: string | null
          symbol: string
          trace_id?: string | null
          unattributed?: boolean
          user_id: string
        }
        Update: {
          closed_at?: string | null
          created_at?: string
          direction?: string
          exit_reason?: string | null
          fees?: number
          hold_seconds?: number | null
          id?: string
          management_actions?: number
          model_attribution?: Json
          onyx_correct?: boolean | null
          onyx_decision?: string | null
          outcome?: string
          paper_trade_id?: string
          participation?: string | null
          pnl_gross?: number
          pnl_net?: number
          r_multiple?: number | null
          regime?: string | null
          scout_rank?: number | null
          strategy?: string | null
          symbol?: string
          trace_id?: string | null
          unattributed?: boolean
          user_id?: string
        }
        Relationships: []
      }
      paper_trades: {
        Row: {
          closed_at: string
          created_at: string
          direction: string
          entry_price: number
          exit_price: number
          exit_reason: string
          fees: number
          hold_seconds: number
          id: string
          leverage: number
          margin: number
          onyx_decision_id: string | null
          opened_at: string
          orchestration_trace_id: string | null
          pnl_gross: number
          pnl_net: number
          position_id: string | null
          size_notional: number
          size_qty: number
          slippage_cost: number
          symbol: string
          user_id: string
          wallet_key: string
        }
        Insert: {
          closed_at: string
          created_at?: string
          direction: string
          entry_price: number
          exit_price: number
          exit_reason: string
          fees: number
          hold_seconds: number
          id?: string
          leverage: number
          margin: number
          onyx_decision_id?: string | null
          opened_at: string
          orchestration_trace_id?: string | null
          pnl_gross: number
          pnl_net: number
          position_id?: string | null
          size_notional: number
          size_qty: number
          slippage_cost: number
          symbol: string
          user_id: string
          wallet_key: string
        }
        Update: {
          closed_at?: string
          created_at?: string
          direction?: string
          entry_price?: number
          exit_price?: number
          exit_reason?: string
          fees?: number
          hold_seconds?: number
          id?: string
          leverage?: number
          margin?: number
          onyx_decision_id?: string | null
          opened_at?: string
          orchestration_trace_id?: string | null
          pnl_gross?: number
          pnl_net?: number
          position_id?: string | null
          size_notional?: number
          size_qty?: number
          slippage_cost?: number
          symbol?: string
          user_id?: string
          wallet_key?: string
        }
        Relationships: []
      }
      paper_wallet_legs: {
        Row: {
          assigned_symbol: string | null
          authorization_id: string | null
          balance: number | null
          correlation_id: string | null
          created_at: string
          detail: Json
          id: string
          last_transition_at: string | null
          leg_direction: string
          pod_id: string
          position_id: string | null
          purpose: string | null
          reservation_expires_at: string | null
          state: string
          updated_at: string
          user_id: string
          wallet_key: string | null
        }
        Insert: {
          assigned_symbol?: string | null
          authorization_id?: string | null
          balance?: number | null
          correlation_id?: string | null
          created_at?: string
          detail?: Json
          id?: string
          last_transition_at?: string | null
          leg_direction: string
          pod_id: string
          position_id?: string | null
          purpose?: string | null
          reservation_expires_at?: string | null
          state?: string
          updated_at?: string
          user_id: string
          wallet_key?: string | null
        }
        Update: {
          assigned_symbol?: string | null
          authorization_id?: string | null
          balance?: number | null
          correlation_id?: string | null
          created_at?: string
          detail?: Json
          id?: string
          last_transition_at?: string | null
          leg_direction?: string
          pod_id?: string
          position_id?: string | null
          purpose?: string | null
          reservation_expires_at?: string | null
          state?: string
          updated_at?: string
          user_id?: string
          wallet_key?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "paper_wallet_legs_pod_id_fkey"
            columns: ["pod_id"]
            isOneToOne: false
            referencedRelation: "paper_symbol_pods"
            referencedColumns: ["id"]
          },
        ]
      }
      paper_wallets: {
        Row: {
          activated_at: string | null
          activated_by: string | null
          balance: number
          balance_source: string
          created_at: string
          direction_scope: string
          environment: string
          execution_enabled: boolean
          floor_hit: boolean
          id: string
          last_processed_candle_ts_ms: number | null
          last_tick_at: string | null
          losses_count: number
          monitor_role: string | null
          open_position_id: string | null
          realized_pnl: number
          status: string
          trades_count: number
          updated_at: string
          user_id: string
          wallet_key: string
          wins_count: number
        }
        Insert: {
          activated_at?: string | null
          activated_by?: string | null
          balance?: number
          balance_source?: string
          created_at?: string
          direction_scope?: string
          environment?: string
          execution_enabled?: boolean
          floor_hit?: boolean
          id?: string
          last_processed_candle_ts_ms?: number | null
          last_tick_at?: string | null
          losses_count?: number
          monitor_role?: string | null
          open_position_id?: string | null
          realized_pnl?: number
          status?: string
          trades_count?: number
          updated_at?: string
          user_id: string
          wallet_key: string
          wins_count?: number
        }
        Update: {
          activated_at?: string | null
          activated_by?: string | null
          balance?: number
          balance_source?: string
          created_at?: string
          direction_scope?: string
          environment?: string
          execution_enabled?: boolean
          floor_hit?: boolean
          id?: string
          last_processed_candle_ts_ms?: number | null
          last_tick_at?: string | null
          losses_count?: number
          monitor_role?: string | null
          open_position_id?: string | null
          realized_pnl?: number
          status?: string
          trades_count?: number
          updated_at?: string
          user_id?: string
          wallet_key?: string
          wins_count?: number
        }
        Relationships: []
      }
      point_awards: {
        Row: {
          awarded_at: string
          billing_period: string | null
          category_id: string | null
          entry_type: string
          id: string
          idempotency_key: string
          milestone_code: string
          points: number
          source_history_id: string | null
          user_id: string
        }
        Insert: {
          awarded_at?: string
          billing_period?: string | null
          category_id?: string | null
          entry_type?: string
          id?: string
          idempotency_key: string
          milestone_code: string
          points: number
          source_history_id?: string | null
          user_id: string
        }
        Update: {
          awarded_at?: string
          billing_period?: string | null
          category_id?: string | null
          entry_type?: string
          id?: string
          idempotency_key?: string
          milestone_code?: string
          points?: number
          source_history_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "point_awards_milestone_code_fkey"
            columns: ["milestone_code"]
            isOneToOne: false
            referencedRelation: "milestone_definitions"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "point_awards_source_history_id_fkey"
            columns: ["source_history_id"]
            isOneToOne: false
            referencedRelation: "life_obligation_history"
            referencedColumns: ["id"]
          },
        ]
      }
      point_ledger: {
        Row: {
          created_at: string
          id: string
          idempotency_key: string
          intent_id: string | null
          metadata: Json
          obligation_id: string | null
          points: number
          reason: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          idempotency_key: string
          intent_id?: string | null
          metadata?: Json
          obligation_id?: string | null
          points: number
          reason: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          idempotency_key?: string
          intent_id?: string | null
          metadata?: Json
          obligation_id?: string | null
          points?: number
          reason?: string
          user_id?: string
        }
        Relationships: []
      }
      positions: {
        Row: {
          autopilot_workflow_id: string | null
          connection_id: string | null
          current_price: number
          decision_id: string | null
          entry_price: number
          exchange: string
          id: string
          leverage: number | null
          liquidation_price: number | null
          mark_price: number | null
          market_type: Database["public"]["Enums"]["account_mode"]
          open_orders: Json
          opened_at: string
          pair: string
          pnl_amount: number
          pnl_pct: number
          side: Database["public"]["Enums"]["position_side"]
          size: number
          source: string
          status: Database["public"]["Enums"]["position_status"]
          strategy_id: string | null
          strategy_metadata: Json
          synced_at: string | null
          tp_candles_required: number
          tp_execution_timeframe: string
          tp_fill_ts: string | null
          tp_last_decision: string | null
          tp_last_reviewed_at: string | null
          tp_price: number | null
          tp_review_seq: number
          tp_state: string
          tp_tiers: Json | null
          tp_venue_order_id: string | null
          unrealized_pnl: number
          updated_at: string
          user_id: string
          venue_order_id: string | null
          wallet_connection_id: string | null
        }
        Insert: {
          autopilot_workflow_id?: string | null
          connection_id?: string | null
          current_price: number
          decision_id?: string | null
          entry_price: number
          exchange: string
          id?: string
          leverage?: number | null
          liquidation_price?: number | null
          mark_price?: number | null
          market_type: Database["public"]["Enums"]["account_mode"]
          open_orders?: Json
          opened_at?: string
          pair: string
          pnl_amount?: number
          pnl_pct?: number
          side: Database["public"]["Enums"]["position_side"]
          size?: number
          source?: string
          status?: Database["public"]["Enums"]["position_status"]
          strategy_id?: string | null
          strategy_metadata?: Json
          synced_at?: string | null
          tp_candles_required?: number
          tp_execution_timeframe?: string
          tp_fill_ts?: string | null
          tp_last_decision?: string | null
          tp_last_reviewed_at?: string | null
          tp_price?: number | null
          tp_review_seq?: number
          tp_state?: string
          tp_tiers?: Json | null
          tp_venue_order_id?: string | null
          unrealized_pnl?: number
          updated_at?: string
          user_id: string
          venue_order_id?: string | null
          wallet_connection_id?: string | null
        }
        Update: {
          autopilot_workflow_id?: string | null
          connection_id?: string | null
          current_price?: number
          decision_id?: string | null
          entry_price?: number
          exchange?: string
          id?: string
          leverage?: number | null
          liquidation_price?: number | null
          mark_price?: number | null
          market_type?: Database["public"]["Enums"]["account_mode"]
          open_orders?: Json
          opened_at?: string
          pair?: string
          pnl_amount?: number
          pnl_pct?: number
          side?: Database["public"]["Enums"]["position_side"]
          size?: number
          source?: string
          status?: Database["public"]["Enums"]["position_status"]
          strategy_id?: string | null
          strategy_metadata?: Json
          synced_at?: string | null
          tp_candles_required?: number
          tp_execution_timeframe?: string
          tp_fill_ts?: string | null
          tp_last_decision?: string | null
          tp_last_reviewed_at?: string | null
          tp_price?: number | null
          tp_review_seq?: number
          tp_state?: string
          tp_tiers?: Json | null
          tp_venue_order_id?: string | null
          unrealized_pnl?: number
          updated_at?: string
          user_id?: string
          venue_order_id?: string | null
          wallet_connection_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "positions_autopilot_workflow_id_fkey"
            columns: ["autopilot_workflow_id"]
            isOneToOne: false
            referencedRelation: "autopilot_workflows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "positions_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "active_bot_config"
            referencedColumns: ["connection_id"]
          },
          {
            foreignKeyName: "positions_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "positions_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "strategy_decisions"
            referencedColumns: ["decision_id"]
          },
          {
            foreignKeyName: "positions_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "positions_wallet_connection_id_fkey"
            columns: ["wallet_connection_id"]
            isOneToOne: false
            referencedRelation: "wallet_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      push_device_tokens: {
        Row: {
          created_at: string
          id: string
          last_seen_at: string
          platform: string
          token: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_seen_at?: string
          platform: string
          token: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          last_seen_at?: string
          platform?: string
          token?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          account_mode: Database["public"]["Enums"]["account_mode"]
          active_goal_name: string | null
          active_goal_target: number | null
          active_wallet_usd: number
          ai_data_consent_at: string | null
          ai_data_consent_version: string | null
          avatar_url: string | null
          bills_prompt_dismissed_at: string | null
          bot_status: Database["public"]["Enums"]["bot_status"]
          created_at: string
          current_leverage_tier: number
          demo_mode: boolean
          display_name: string | null
          face_id_enabled: boolean
          favorite_character: string | null
          id: string
          life_map_migrated_at: string | null
          lifetime_harvested_cash: number
          notifications_enabled: boolean
          onboarding_complete: boolean
          onboarding_complete_v2: boolean
          phone: string | null
          pin_hash: string | null
          risk_acknowledged: boolean
          risk_acknowledged_at: string | null
          strategy_mode: Database["public"]["Enums"]["strategy_mode"]
          target_budget_items: Json
          target_budget_items_backup: Json | null
          updated_at: string
        }
        Insert: {
          account_mode?: Database["public"]["Enums"]["account_mode"]
          active_goal_name?: string | null
          active_goal_target?: number | null
          active_wallet_usd?: number
          ai_data_consent_at?: string | null
          ai_data_consent_version?: string | null
          avatar_url?: string | null
          bills_prompt_dismissed_at?: string | null
          bot_status?: Database["public"]["Enums"]["bot_status"]
          created_at?: string
          current_leverage_tier?: number
          demo_mode?: boolean
          display_name?: string | null
          face_id_enabled?: boolean
          favorite_character?: string | null
          id: string
          life_map_migrated_at?: string | null
          lifetime_harvested_cash?: number
          notifications_enabled?: boolean
          onboarding_complete?: boolean
          onboarding_complete_v2?: boolean
          phone?: string | null
          pin_hash?: string | null
          risk_acknowledged?: boolean
          risk_acknowledged_at?: string | null
          strategy_mode?: Database["public"]["Enums"]["strategy_mode"]
          target_budget_items?: Json
          target_budget_items_backup?: Json | null
          updated_at?: string
        }
        Update: {
          account_mode?: Database["public"]["Enums"]["account_mode"]
          active_goal_name?: string | null
          active_goal_target?: number | null
          active_wallet_usd?: number
          ai_data_consent_at?: string | null
          ai_data_consent_version?: string | null
          avatar_url?: string | null
          bills_prompt_dismissed_at?: string | null
          bot_status?: Database["public"]["Enums"]["bot_status"]
          created_at?: string
          current_leverage_tier?: number
          demo_mode?: boolean
          display_name?: string | null
          face_id_enabled?: boolean
          favorite_character?: string | null
          id?: string
          life_map_migrated_at?: string | null
          lifetime_harvested_cash?: number
          notifications_enabled?: boolean
          onboarding_complete?: boolean
          onboarding_complete_v2?: boolean
          phone?: string | null
          pin_hash?: string | null
          risk_acknowledged?: boolean
          risk_acknowledged_at?: string | null
          strategy_mode?: Database["public"]["Enums"]["strategy_mode"]
          target_budget_items?: Json
          target_budget_items_backup?: Json | null
          updated_at?: string
        }
        Relationships: []
      }
      proof_authorizations: {
        Row: {
          consumed_at: string | null
          consumed_by_idempotency_key: string | null
          created_at: string
          id: string
          symbol: string
          token: string
          user_id: string
        }
        Insert: {
          consumed_at?: string | null
          consumed_by_idempotency_key?: string | null
          created_at?: string
          id?: string
          symbol: string
          token: string
          user_id: string
        }
        Update: {
          consumed_at?: string | null
          consumed_by_idempotency_key?: string | null
          created_at?: string
          id?: string
          symbol?: string
          token?: string
          user_id?: string
        }
        Relationships: []
      }
      risk_capital_allocations: {
        Row: {
          amount: number
          confirmed_at: string | null
          connection_id: string | null
          created_at: string
          currency: string
          designated_at: string | null
          id: string
          revoked_at: string | null
          source: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          amount?: number
          confirmed_at?: string | null
          connection_id?: string | null
          created_at?: string
          currency?: string
          designated_at?: string | null
          id?: string
          revoked_at?: string | null
          source?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          amount?: number
          confirmed_at?: string | null
          connection_id?: string | null
          created_at?: string
          currency?: string
          designated_at?: string | null
          id?: string
          revoked_at?: string | null
          source?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "risk_capital_allocations_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "active_bot_config"
            referencedColumns: ["connection_id"]
          },
          {
            foreignKeyName: "risk_capital_allocations_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      scout_bias_state: {
        Row: {
          bias: string
          last_score: number
          streak: number
          symbol: string
          updated_at: string
          user_id: string
        }
        Insert: {
          bias: string
          last_score?: number
          streak?: number
          symbol: string
          updated_at?: string
          user_id: string
        }
        Update: {
          bias?: string
          last_score?: number
          streak?: number
          symbol?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      scout_corrections: {
        Row: {
          created_at: string
          id: string
          reason: string
          signal_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          reason: string
          signal_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          reason?: string
          signal_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "scout_corrections_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "scout_signals"
            referencedColumns: ["id"]
          },
        ]
      }
      scout_evidence: {
        Row: {
          age_ms: number | null
          candle_count: number | null
          created_at: string
          direction: string | null
          evidence: Json | null
          evidence_schema_version: number
          fresh: boolean | null
          id: string
          last_closed_ts: number | null
          last_closed_ts_ms: number | null
          missing_fields: string[]
          reasons: string[]
          rules_version: number
          scan_id: string | null
          score: number
          signal_id: string
          stale: boolean
          state: string
          symbol: string | null
          timeframe: string
          user_id: string
          weighted_score: number | null
        }
        Insert: {
          age_ms?: number | null
          candle_count?: number | null
          created_at?: string
          direction?: string | null
          evidence?: Json | null
          evidence_schema_version?: number
          fresh?: boolean | null
          id?: string
          last_closed_ts?: number | null
          last_closed_ts_ms?: number | null
          missing_fields?: string[]
          reasons?: string[]
          rules_version?: number
          scan_id?: string | null
          score: number
          signal_id: string
          stale?: boolean
          state: string
          symbol?: string | null
          timeframe: string
          user_id: string
          weighted_score?: number | null
        }
        Update: {
          age_ms?: number | null
          candle_count?: number | null
          created_at?: string
          direction?: string | null
          evidence?: Json | null
          evidence_schema_version?: number
          fresh?: boolean | null
          id?: string
          last_closed_ts?: number | null
          last_closed_ts_ms?: number | null
          missing_fields?: string[]
          reasons?: string[]
          rules_version?: number
          scan_id?: string | null
          score?: number
          signal_id?: string
          stale?: boolean
          state?: string
          symbol?: string | null
          timeframe?: string
          user_id?: string
          weighted_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "scout_evidence_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "scout_signals"
            referencedColumns: ["id"]
          },
        ]
      }
      scout_guardian_directives: {
        Row: {
          consumed_at: string | null
          consumed_by: string | null
          correlation_id: string | null
          created_at: string
          directive_type: string
          evidence: Json
          guardian_cycle_ts_ms: number | null
          id: string
          position_id: string
          reason_code: string
          status: string
          symbol: string
          user_id: string
          wallet_key: string | null
        }
        Insert: {
          consumed_at?: string | null
          consumed_by?: string | null
          correlation_id?: string | null
          created_at?: string
          directive_type: string
          evidence?: Json
          guardian_cycle_ts_ms?: number | null
          id?: string
          position_id: string
          reason_code: string
          status?: string
          symbol: string
          user_id: string
          wallet_key?: string | null
        }
        Update: {
          consumed_at?: string | null
          consumed_by?: string | null
          correlation_id?: string | null
          created_at?: string
          directive_type?: string
          evidence?: Json
          guardian_cycle_ts_ms?: number | null
          id?: string
          position_id?: string
          reason_code?: string
          status?: string
          symbol?: string
          user_id?: string
          wallet_key?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scout_guardian_directives_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "paper_positions"
            referencedColumns: ["id"]
          },
        ]
      }
      scout_outcomes: {
        Row: {
          bars_used: number | null
          created_at: string
          evidence_id: string | null
          hit_invalidation: boolean
          id: string
          mae_pct: number | null
          mfe_pct: number | null
          net_pct: number | null
          observed_until: string
          outcome_schema_version: number
          reason_codes: string[]
          rules_version: number
          signal_id: string
          status: string | null
          supersedes_id: string | null
          target_hit: boolean | null
          user_id: string
          window_key: string | null
        }
        Insert: {
          bars_used?: number | null
          created_at?: string
          evidence_id?: string | null
          hit_invalidation?: boolean
          id?: string
          mae_pct?: number | null
          mfe_pct?: number | null
          net_pct?: number | null
          observed_until?: string
          outcome_schema_version?: number
          reason_codes?: string[]
          rules_version?: number
          signal_id: string
          status?: string | null
          supersedes_id?: string | null
          target_hit?: boolean | null
          user_id: string
          window_key?: string | null
        }
        Update: {
          bars_used?: number | null
          created_at?: string
          evidence_id?: string | null
          hit_invalidation?: boolean
          id?: string
          mae_pct?: number | null
          mfe_pct?: number | null
          net_pct?: number | null
          observed_until?: string
          outcome_schema_version?: number
          reason_codes?: string[]
          rules_version?: number
          signal_id?: string
          status?: string | null
          supersedes_id?: string | null
          target_hit?: boolean | null
          user_id?: string
          window_key?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scout_outcomes_evidence_id_fkey"
            columns: ["evidence_id"]
            isOneToOne: false
            referencedRelation: "scout_evidence"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scout_outcomes_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "scout_signals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scout_outcomes_supersedes_id_fkey"
            columns: ["supersedes_id"]
            isOneToOne: false
            referencedRelation: "scout_outcomes"
            referencedColumns: ["id"]
          },
        ]
      }
      scout_preferences: {
        Row: {
          active: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          active?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          active?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      scout_ranking_state: {
        Row: {
          connection_id: string | null
          cooldown_until: string | null
          environment: Database["public"]["Enums"]["scout_environment"]
          exchange: string
          id: string
          last_adjusted_score: number
          last_bucket: Database["public"]["Enums"]["scout_ranking_bucket"]
          last_rank: number | null
          last_transition_at: string | null
          market_type: Database["public"]["Enums"]["scout_market_type"]
          ranking_version: number
          streak: number
          symbol: string
          updated_at: string
          user_id: string
        }
        Insert: {
          connection_id?: string | null
          cooldown_until?: string | null
          environment: Database["public"]["Enums"]["scout_environment"]
          exchange: string
          id?: string
          last_adjusted_score?: number
          last_bucket?: Database["public"]["Enums"]["scout_ranking_bucket"]
          last_rank?: number | null
          last_transition_at?: string | null
          market_type: Database["public"]["Enums"]["scout_market_type"]
          ranking_version?: number
          streak?: number
          symbol: string
          updated_at?: string
          user_id: string
        }
        Update: {
          connection_id?: string | null
          cooldown_until?: string | null
          environment?: Database["public"]["Enums"]["scout_environment"]
          exchange?: string
          id?: string
          last_adjusted_score?: number
          last_bucket?: Database["public"]["Enums"]["scout_ranking_bucket"]
          last_rank?: number | null
          last_transition_at?: string | null
          market_type?: Database["public"]["Enums"]["scout_market_type"]
          ranking_version?: number
          streak?: number
          symbol?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      scout_rotation_state: {
        Row: {
          created_at: string
          detail: Json
          discovered_count: number
          eligible_count: number
          environment: Database["public"]["Enums"]["scout_environment"]
          exchange: string
          fresh_covered_count: number
          id: string
          last_cursor: number
          last_scan_id: string | null
          last_snapshot_id: string | null
          market_type: Database["public"]["Enums"]["scout_market_type"]
          next_rotation: number
          ranked_count: number
          rejected_count: number
          scanned_this_cycle: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          detail?: Json
          discovered_count?: number
          eligible_count?: number
          environment: Database["public"]["Enums"]["scout_environment"]
          exchange: string
          fresh_covered_count?: number
          id?: string
          last_cursor?: number
          last_scan_id?: string | null
          last_snapshot_id?: string | null
          market_type: Database["public"]["Enums"]["scout_market_type"]
          next_rotation?: number
          ranked_count?: number
          rejected_count?: number
          scanned_this_cycle?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          detail?: Json
          discovered_count?: number
          eligible_count?: number
          environment?: Database["public"]["Enums"]["scout_environment"]
          exchange?: string
          fresh_covered_count?: number
          id?: string
          last_cursor?: number
          last_scan_id?: string | null
          last_snapshot_id?: string | null
          market_type?: Database["public"]["Enums"]["scout_market_type"]
          next_rotation?: number
          ranked_count?: number
          rejected_count?: number
          scanned_this_cycle?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "scout_rotation_state_last_scan_id_fkey"
            columns: ["last_scan_id"]
            isOneToOne: false
            referencedRelation: "scout_scans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scout_rotation_state_last_snapshot_id_fkey"
            columns: ["last_snapshot_id"]
            isOneToOne: false
            referencedRelation: "scout_universe_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      scout_rule_proposals: {
        Row: {
          after_rules: Json
          backtest_summary: Json
          before_rules: Json
          created_at: string
          created_by: string | null
          id: string
          proposal_key: string
          reviewed_at: string | null
          reviewed_by: string | null
          rules_version: number
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          after_rules?: Json
          backtest_summary?: Json
          before_rules?: Json
          created_at?: string
          created_by?: string | null
          id?: string
          proposal_key: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          rules_version?: number
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          after_rules?: Json
          backtest_summary?: Json
          before_rules?: Json
          created_at?: string
          created_by?: string | null
          id?: string
          proposal_key?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          rules_version?: number
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      scout_scans: {
        Row: {
          error: string | null
          finished_at: string | null
          health: string
          id: string
          minute_bucket: string
          started_at: string
          symbol_count: number
          user_id: string
        }
        Insert: {
          error?: string | null
          finished_at?: string | null
          health?: string
          id?: string
          minute_bucket: string
          started_at?: string
          symbol_count?: number
          user_id: string
        }
        Update: {
          error?: string | null
          finished_at?: string | null
          health?: string
          id?: string
          minute_bucket?: string
          started_at?: string
          symbol_count?: number
          user_id?: string
        }
        Relationships: []
      }
      scout_signal_state: {
        Row: {
          aligned_streak: number
          created_at: string
          direction: string
          entered_at: string
          id: string
          last_scan_id: string | null
          prior_state: string | null
          reason_codes: string[]
          state: string
          state_schema_version: number
          symbol: string
          updated_at: string
          user_id: string
          weighted_score: number
        }
        Insert: {
          aligned_streak?: number
          created_at?: string
          direction?: string
          entered_at?: string
          id?: string
          last_scan_id?: string | null
          prior_state?: string | null
          reason_codes?: string[]
          state: string
          state_schema_version?: number
          symbol: string
          updated_at?: string
          user_id: string
          weighted_score?: number
        }
        Update: {
          aligned_streak?: number
          created_at?: string
          direction?: string
          entered_at?: string
          id?: string
          last_scan_id?: string | null
          prior_state?: string | null
          reason_codes?: string[]
          state?: string
          state_schema_version?: number
          symbol?: string
          updated_at?: string
          user_id?: string
          weighted_score?: number
        }
        Relationships: []
      }
      scout_signals: {
        Row: {
          availability: number
          bias: string
          confidence: number
          conflict: number
          created_at: string
          dominant_side: string
          expires_at: string
          id: string
          invalidated_at: string | null
          long_aligned_tfs: string[]
          long_fresh: boolean
          long_insufficient: boolean
          long_reason_codes: string[]
          long_score: number
          long_state: string
          market_regime: string | null
          readiness: string
          regime_evidence: Json | null
          regime_schema_version: number | null
          scan_id: string
          short_aligned_tfs: string[]
          short_fresh: boolean
          short_insufficient: boolean
          short_reason_codes: string[]
          short_score: number
          short_state: string
          symbol: string
          user_id: string
          weighted_score: number
        }
        Insert: {
          availability: number
          bias: string
          confidence: number
          conflict: number
          created_at?: string
          dominant_side?: string
          expires_at: string
          id?: string
          invalidated_at?: string | null
          long_aligned_tfs?: string[]
          long_fresh?: boolean
          long_insufficient?: boolean
          long_reason_codes?: string[]
          long_score?: number
          long_state?: string
          market_regime?: string | null
          readiness: string
          regime_evidence?: Json | null
          regime_schema_version?: number | null
          scan_id: string
          short_aligned_tfs?: string[]
          short_fresh?: boolean
          short_insufficient?: boolean
          short_reason_codes?: string[]
          short_score?: number
          short_state?: string
          symbol: string
          user_id: string
          weighted_score: number
        }
        Update: {
          availability?: number
          bias?: string
          confidence?: number
          conflict?: number
          created_at?: string
          dominant_side?: string
          expires_at?: string
          id?: string
          invalidated_at?: string | null
          long_aligned_tfs?: string[]
          long_fresh?: boolean
          long_insufficient?: boolean
          long_reason_codes?: string[]
          long_score?: number
          long_state?: string
          market_regime?: string | null
          readiness?: string
          regime_evidence?: Json | null
          regime_schema_version?: number | null
          scan_id?: string
          short_aligned_tfs?: string[]
          short_fresh?: boolean
          short_insufficient?: boolean
          short_reason_codes?: string[]
          short_score?: number
          short_state?: string
          symbol?: string
          user_id?: string
          weighted_score?: number
        }
        Relationships: [
          {
            foreignKeyName: "scout_signals_scan_id_fkey"
            columns: ["scan_id"]
            isOneToOne: false
            referencedRelation: "scout_scans"
            referencedColumns: ["id"]
          },
        ]
      }
      scout_state_transitions: {
        Row: {
          created_at: string
          direction: string
          from_state: string
          id: string
          reason_codes: string[]
          scan_id: string | null
          state_schema_version: number
          symbol: string
          to_state: string
          user_id: string
          weighted_score: number
        }
        Insert: {
          created_at?: string
          direction?: string
          from_state: string
          id?: string
          reason_codes?: string[]
          scan_id?: string | null
          state_schema_version?: number
          symbol: string
          to_state: string
          user_id: string
          weighted_score?: number
        }
        Update: {
          created_at?: string
          direction?: string
          from_state?: string
          id?: string
          reason_codes?: string[]
          scan_id?: string | null
          state_schema_version?: number
          symbol?: string
          to_state?: string
          user_id?: string
          weighted_score?: number
        }
        Relationships: []
      }
      scout_symbol_rankings: {
        Row: {
          adjusted_score: number
          bucket: Database["public"]["Enums"]["scout_ranking_bucket"]
          correlation_id: string
          created_at: string
          direction: string
          exchange_max_leverage: number | null
          expires_at: string
          generated_at: string
          id: string
          liquidity_usd: number | null
          rank: number | null
          ranking_version: number
          raw_score: number
          rejection_reasons: string[]
          score_components: Json
          signal_fresh: boolean
          snapshot_id: string
          spread_bps: number | null
          symbol: string
          universe_version: number
          user_id: string
          volatility_pct: number | null
        }
        Insert: {
          adjusted_score?: number
          bucket: Database["public"]["Enums"]["scout_ranking_bucket"]
          correlation_id: string
          created_at?: string
          direction?: string
          exchange_max_leverage?: number | null
          expires_at: string
          generated_at?: string
          id?: string
          liquidity_usd?: number | null
          rank?: number | null
          ranking_version?: number
          raw_score?: number
          rejection_reasons?: string[]
          score_components?: Json
          signal_fresh?: boolean
          snapshot_id: string
          spread_bps?: number | null
          symbol: string
          universe_version?: number
          user_id: string
          volatility_pct?: number | null
        }
        Update: {
          adjusted_score?: number
          bucket?: Database["public"]["Enums"]["scout_ranking_bucket"]
          correlation_id?: string
          created_at?: string
          direction?: string
          exchange_max_leverage?: number | null
          expires_at?: string
          generated_at?: string
          id?: string
          liquidity_usd?: number | null
          rank?: number | null
          ranking_version?: number
          raw_score?: number
          rejection_reasons?: string[]
          score_components?: Json
          signal_fresh?: boolean
          snapshot_id?: string
          spread_bps?: number | null
          symbol?: string
          universe_version?: number
          user_id?: string
          volatility_pct?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "scout_symbol_rankings_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "scout_universe_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      scout_universe_overrides: {
        Row: {
          connection_id: string | null
          created_at: string
          environment: Database["public"]["Enums"]["scout_environment"]
          exchange: string
          expires_at: string | null
          id: string
          kind: Database["public"]["Enums"]["scout_override_kind"]
          market_type: Database["public"]["Enums"]["scout_market_type"]
          reason: string | null
          symbol: string
          updated_at: string
          user_id: string
        }
        Insert: {
          connection_id?: string | null
          created_at?: string
          environment: Database["public"]["Enums"]["scout_environment"]
          exchange: string
          expires_at?: string | null
          id?: string
          kind: Database["public"]["Enums"]["scout_override_kind"]
          market_type: Database["public"]["Enums"]["scout_market_type"]
          reason?: string | null
          symbol: string
          updated_at?: string
          user_id: string
        }
        Update: {
          connection_id?: string | null
          created_at?: string
          environment?: Database["public"]["Enums"]["scout_environment"]
          exchange?: string
          expires_at?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["scout_override_kind"]
          market_type?: Database["public"]["Enums"]["scout_market_type"]
          reason?: string | null
          symbol?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      scout_universe_snapshots: {
        Row: {
          adapter_version: number
          capability_version: number
          connection_id: string | null
          correlation_id: string
          created_at: string
          detail: Json
          eligible_count: number
          environment: Database["public"]["Enums"]["scout_environment"]
          exchange: string
          exchange_symbol_count: number
          expires_at: string
          generated_at: string
          health: Database["public"]["Enums"]["scout_universe_health"]
          id: string
          market_type: Database["public"]["Enums"]["scout_market_type"]
          ranked_count: number
          ranking_version: number
          rejected_count: number
          universe_version: number
          updated_at: string
          user_id: string
        }
        Insert: {
          adapter_version: number
          capability_version: number
          connection_id?: string | null
          correlation_id: string
          created_at?: string
          detail?: Json
          eligible_count?: number
          environment: Database["public"]["Enums"]["scout_environment"]
          exchange: string
          exchange_symbol_count?: number
          expires_at: string
          generated_at?: string
          health: Database["public"]["Enums"]["scout_universe_health"]
          id?: string
          market_type: Database["public"]["Enums"]["scout_market_type"]
          ranked_count?: number
          ranking_version?: number
          rejected_count?: number
          universe_version?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          adapter_version?: number
          capability_version?: number
          connection_id?: string | null
          correlation_id?: string
          created_at?: string
          detail?: Json
          eligible_count?: number
          environment?: Database["public"]["Enums"]["scout_environment"]
          exchange?: string
          exchange_symbol_count?: number
          expires_at?: string
          generated_at?: string
          health?: Database["public"]["Enums"]["scout_universe_health"]
          id?: string
          market_type?: Database["public"]["Enums"]["scout_market_type"]
          ranked_count?: number
          ranking_version?: number
          rejected_count?: number
          universe_version?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      strategies: {
        Row: {
          created_at: string
          description: string
          id: string
          markets: Database["public"]["Enums"]["market_support"]
          name: string
          ring_color: string
          risk: Database["public"]["Enums"]["risk_level"]
          slug: string
          sort_order: number
          suit_design: string
          suit_image: string
          suit_name: string
          trait: string
        }
        Insert: {
          created_at?: string
          description: string
          id?: string
          markets: Database["public"]["Enums"]["market_support"]
          name: string
          ring_color: string
          risk: Database["public"]["Enums"]["risk_level"]
          slug: string
          sort_order?: number
          suit_design: string
          suit_image: string
          suit_name: string
          trait: string
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          markets?: Database["public"]["Enums"]["market_support"]
          name?: string
          ring_color?: string
          risk?: Database["public"]["Enums"]["risk_level"]
          slug?: string
          sort_order?: number
          suit_design?: string
          suit_image?: string
          suit_name?: string
          trait?: string
        }
        Relationships: []
      }
      strategy_candidates: {
        Row: {
          ai_shadow_state: string
          candidate_id: string
          candle_close_at: string
          connection_id: string | null
          created_at: string
          direction: string
          entry_zone: Json | null
          evidence: Json
          evidence_hash: string
          freshness_ms: number | null
          idempotency_key: string | null
          invalidation: number | null
          market_data_at: string | null
          schema_version: string
          strategy: string
          symbol: string
          technical_decision: string
          technical_reason: string | null
          timeframe: string
          tp_ladder: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          ai_shadow_state?: string
          candidate_id: string
          candle_close_at: string
          connection_id?: string | null
          created_at?: string
          direction: string
          entry_zone?: Json | null
          evidence?: Json
          evidence_hash: string
          freshness_ms?: number | null
          idempotency_key?: string | null
          invalidation?: number | null
          market_data_at?: string | null
          schema_version?: string
          strategy: string
          symbol: string
          technical_decision?: string
          technical_reason?: string | null
          timeframe: string
          tp_ladder?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          ai_shadow_state?: string
          candidate_id?: string
          candle_close_at?: string
          connection_id?: string | null
          created_at?: string
          direction?: string
          entry_zone?: Json | null
          evidence?: Json
          evidence_hash?: string
          freshness_ms?: number | null
          idempotency_key?: string | null
          invalidation?: number | null
          market_data_at?: string | null
          schema_version?: string
          strategy?: string
          symbol?: string
          technical_decision?: string
          technical_reason?: string | null
          timeframe?: string
          tp_ladder?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      strategy_decisions: {
        Row: {
          apex_result: Json | null
          armed_leg: string | null
          candle_close_at: string
          connection_id: string
          created_at: string
          decision_id: string
          direction: string
          entry_zone: Json | null
          evidence: Json
          evidence_hash: string
          execution_reason_code: string | null
          execution_state: string
          execution_updated_at: string | null
          invalidation: number | null
          order_intent: Json | null
          reason: string
          reason_code: string
          risk_check: Json | null
          safety_checks: Json | null
          schema_version: string
          simulated_intent: Json | null
          strategy: string
          symbol: string
          take_profits: Json
          terminal_at: string | null
          terminal_outcome: string | null
          terminal_reason: string | null
          timeframe: string
          trace_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          apex_result?: Json | null
          armed_leg?: string | null
          candle_close_at: string
          connection_id: string
          created_at?: string
          decision_id: string
          direction: string
          entry_zone?: Json | null
          evidence?: Json
          evidence_hash: string
          execution_reason_code?: string | null
          execution_state?: string
          execution_updated_at?: string | null
          invalidation?: number | null
          order_intent?: Json | null
          reason?: string
          reason_code: string
          risk_check?: Json | null
          safety_checks?: Json | null
          schema_version?: string
          simulated_intent?: Json | null
          strategy: string
          symbol: string
          take_profits?: Json
          terminal_at?: string | null
          terminal_outcome?: string | null
          terminal_reason?: string | null
          timeframe?: string
          trace_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          apex_result?: Json | null
          armed_leg?: string | null
          candle_close_at?: string
          connection_id?: string
          created_at?: string
          decision_id?: string
          direction?: string
          entry_zone?: Json | null
          evidence?: Json
          evidence_hash?: string
          execution_reason_code?: string | null
          execution_state?: string
          execution_updated_at?: string | null
          invalidation?: number | null
          order_intent?: Json | null
          reason?: string
          reason_code?: string
          risk_check?: Json | null
          safety_checks?: Json | null
          schema_version?: string
          simulated_intent?: Json | null
          strategy?: string
          symbol?: string
          take_profits?: Json
          terminal_at?: string | null
          terminal_outcome?: string | null
          terminal_reason?: string | null
          timeframe?: string
          trace_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      strategy_state: {
        Row: {
          connection_id: string
          state: Json
          strategy: string
          updated_at: string
          user_id: string
        }
        Insert: {
          connection_id: string
          state?: Json
          strategy: string
          updated_at?: string
          user_id: string
        }
        Update: {
          connection_id?: string
          state?: Json
          strategy?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "strategy_state_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "active_bot_config"
            referencedColumns: ["connection_id"]
          },
          {
            foreignKeyName: "strategy_state_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          created_at: string
          status: string
          tier: Database["public"]["Enums"]["subscription_tier"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          status?: string
          tier?: Database["public"]["Enums"]["subscription_tier"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          status?: string
          tier?: Database["public"]["Enums"]["subscription_tier"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      telegram_accounts: {
        Row: {
          chat_id: number
          linked_at: string
          telegram_first_name: string | null
          telegram_username: string | null
          user_id: string
        }
        Insert: {
          chat_id: number
          linked_at?: string
          telegram_first_name?: string | null
          telegram_username?: string | null
          user_id: string
        }
        Update: {
          chat_id?: number
          linked_at?: string
          telegram_first_name?: string | null
          telegram_username?: string | null
          user_id?: string
        }
        Relationships: []
      }
      telegram_broadcast_targets: {
        Row: {
          chat_id: number
          chat_type: string
          created_at: string
          registered_by: string | null
          title: string | null
        }
        Insert: {
          chat_id: number
          chat_type: string
          created_at?: string
          registered_by?: string | null
          title?: string | null
        }
        Update: {
          chat_id?: number
          chat_type?: string
          created_at?: string
          registered_by?: string | null
          title?: string | null
        }
        Relationships: []
      }
      telegram_link_codes: {
        Row: {
          code: string
          created_at: string
          expires_at: string
          user_id: string
        }
        Insert: {
          code: string
          created_at?: string
          expires_at: string
          user_id: string
        }
        Update: {
          code?: string
          created_at?: string
          expires_at?: string
          user_id?: string
        }
        Relationships: []
      }
      telegram_pending_trades: {
        Row: {
          candle_close_ms: number
          chat_id: number
          created_at: string
          direction: string
          entry_price: number
          expires_at: string
          max_leverage: number | null
          onyx_rationale: string | null
          step_size: number | null
          stop_level: number | null
          symbol: string
          tick_size: number | null
          tp_levels: Json
          trend_state: string | null
          user_id: string
        }
        Insert: {
          candle_close_ms: number
          chat_id: number
          created_at?: string
          direction: string
          entry_price: number
          expires_at: string
          max_leverage?: number | null
          onyx_rationale?: string | null
          step_size?: number | null
          stop_level?: number | null
          symbol: string
          tick_size?: number | null
          tp_levels?: Json
          trend_state?: string | null
          user_id: string
        }
        Update: {
          candle_close_ms?: number
          chat_id?: number
          created_at?: string
          direction?: string
          entry_price?: number
          expires_at?: string
          max_leverage?: number | null
          onyx_rationale?: string | null
          step_size?: number | null
          stop_level?: number | null
          symbol?: string
          tick_size?: number | null
          tp_levels?: Json
          trend_state?: string | null
          user_id?: string
        }
        Relationships: []
      }
      trades: {
        Row: {
          autopilot_workflow_id: string | null
          book: string
          closed_at: string
          connection_id: string | null
          decision_id: string | null
          entry_price: number
          entry_venue_fill_id: string | null
          evidence_source: string | null
          evidence_verified: boolean
          evidence_verified_at: string | null
          exchange: string
          exit_price: number
          exit_venue_fill_id: string | null
          fees_usd: number
          id: string
          leverage: number | null
          market_type: Database["public"]["Enums"]["account_mode"]
          opened_at: string
          pair: string
          realized_pnl: number
          realized_pnl_pct: number
          side: Database["public"]["Enums"]["position_side"]
          size: number
          strategy_id: string | null
          user_id: string
          venue: string | null
          venue_order_id: string | null
          wallet_connection_id: string | null
        }
        Insert: {
          autopilot_workflow_id?: string | null
          book?: string
          closed_at?: string
          connection_id?: string | null
          decision_id?: string | null
          entry_price: number
          entry_venue_fill_id?: string | null
          evidence_source?: string | null
          evidence_verified?: boolean
          evidence_verified_at?: string | null
          exchange: string
          exit_price: number
          exit_venue_fill_id?: string | null
          fees_usd?: number
          id?: string
          leverage?: number | null
          market_type: Database["public"]["Enums"]["account_mode"]
          opened_at: string
          pair: string
          realized_pnl: number
          realized_pnl_pct: number
          side: Database["public"]["Enums"]["position_side"]
          size: number
          strategy_id?: string | null
          user_id: string
          venue?: string | null
          venue_order_id?: string | null
          wallet_connection_id?: string | null
        }
        Update: {
          autopilot_workflow_id?: string | null
          book?: string
          closed_at?: string
          connection_id?: string | null
          decision_id?: string | null
          entry_price?: number
          entry_venue_fill_id?: string | null
          evidence_source?: string | null
          evidence_verified?: boolean
          evidence_verified_at?: string | null
          exchange?: string
          exit_price?: number
          exit_venue_fill_id?: string | null
          fees_usd?: number
          id?: string
          leverage?: number | null
          market_type?: Database["public"]["Enums"]["account_mode"]
          opened_at?: string
          pair?: string
          realized_pnl?: number
          realized_pnl_pct?: number
          side?: Database["public"]["Enums"]["position_side"]
          size?: number
          strategy_id?: string | null
          user_id?: string
          venue?: string | null
          venue_order_id?: string | null
          wallet_connection_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trades_autopilot_workflow_id_fkey"
            columns: ["autopilot_workflow_id"]
            isOneToOne: false
            referencedRelation: "autopilot_workflows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trades_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "active_bot_config"
            referencedColumns: ["connection_id"]
          },
          {
            foreignKeyName: "trades_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trades_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trades_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "strategy_decisions"
            referencedColumns: ["decision_id"]
          },
          {
            foreignKeyName: "trades_wallet_connection_id_fkey"
            columns: ["wallet_connection_id"]
            isOneToOne: false
            referencedRelation: "wallet_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      trading_communities: {
        Row: {
          applicant_email: string
          applicant_note: string | null
          approved_at: string | null
          approved_by: string | null
          created_at: string
          id: string
          leader_user_id: string | null
          logo_url: string | null
          name: string
          plan_key: string
          seat_limit: number
          slug: string
          status: Database["public"]["Enums"]["community_status"]
          updated_at: string
        }
        Insert: {
          applicant_email: string
          applicant_note?: string | null
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          id?: string
          leader_user_id?: string | null
          logo_url?: string | null
          name: string
          plan_key?: string
          seat_limit?: number
          slug: string
          status?: Database["public"]["Enums"]["community_status"]
          updated_at?: string
        }
        Update: {
          applicant_email?: string
          applicant_note?: string | null
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          id?: string
          leader_user_id?: string | null
          logo_url?: string | null
          name?: string
          plan_key?: string
          seat_limit?: number
          slug?: string
          status?: Database["public"]["Enums"]["community_status"]
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      user_strategy: {
        Row: {
          capability_reconciliation_required: boolean
          connection_id: string
          cross_margin: boolean
          enabled: boolean
          hedge_guard: Json
          margin_mode: string | null
          market_type: Database["public"]["Enums"]["account_mode"]
          mode: string
          params: Json
          strategy_id: string
          symbol: string
          updated_at: string
          user_id: string
        }
        Insert: {
          capability_reconciliation_required?: boolean
          connection_id: string
          cross_margin?: boolean
          enabled?: boolean
          hedge_guard?: Json
          margin_mode?: string | null
          market_type?: Database["public"]["Enums"]["account_mode"]
          mode?: string
          params?: Json
          strategy_id: string
          symbol?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          capability_reconciliation_required?: boolean
          connection_id?: string
          cross_margin?: boolean
          enabled?: boolean
          hedge_guard?: Json
          margin_mode?: string | null
          market_type?: Database["public"]["Enums"]["account_mode"]
          mode?: string
          params?: Json
          strategy_id?: string
          symbol?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_strategy_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "active_bot_config"
            referencedColumns: ["connection_id"]
          },
          {
            foreignKeyName: "user_strategy_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_strategy_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      user_strategy_market_type_backfill: {
        Row: {
          connection_id: string
          created_at: string
          id: string
          mode: string
          new_market_type: string
          previous_market_type: string
          symbol: string
          user_id: string
        }
        Insert: {
          connection_id: string
          created_at?: string
          id?: string
          mode: string
          new_market_type: string
          previous_market_type: string
          symbol: string
          user_id: string
        }
        Update: {
          connection_id?: string
          created_at?: string
          id?: string
          mode?: string
          new_market_type?: string
          previous_market_type?: string
          symbol?: string
          user_id?: string
        }
        Relationships: []
      }
      user_strategy_toggles: {
        Row: {
          enabled: boolean
          strategy: string
          updated_at: string
          user_id: string
        }
        Insert: {
          enabled?: boolean
          strategy: string
          updated_at?: string
          user_id: string
        }
        Update: {
          enabled?: boolean
          strategy?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_trading_limits: {
        Row: {
          created_at: string
          daily_loss_limit_usd: number
          max_leverage: number
          max_order_size_usd: number
          max_total_exposure_usd: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          daily_loss_limit_usd?: number
          max_leverage?: number
          max_order_size_usd?: number
          max_total_exposure_usd?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          daily_loss_limit_usd?: number
          max_leverage?: number
          max_order_size_usd?: number
          max_total_exposure_usd?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_turtle_progress: {
        Row: {
          level: number
          strategy_id: string
          unlocked_cosmetics: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          level?: number
          strategy_id: string
          unlocked_cosmetics?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          level?: number
          strategy_id?: string
          unlocked_cosmetics?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_turtle_progress_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_capabilities: {
        Row: {
          adapter_version: string
          capabilities: Json
          connection_id: string | null
          created_at: string
          environment: string
          exchange: string
          exchange_response_code: string | null
          expires_at: string | null
          id: string
          market_type: string
          position_mode: string
          retrieved_at: string
          source: string
          symbol: string | null
          updated_at: string
          user_id: string | null
          verification_status: string
        }
        Insert: {
          adapter_version: string
          capabilities: Json
          connection_id?: string | null
          created_at?: string
          environment: string
          exchange: string
          exchange_response_code?: string | null
          expires_at?: string | null
          id?: string
          market_type: string
          position_mode?: string
          retrieved_at?: string
          source: string
          symbol?: string | null
          updated_at?: string
          user_id?: string | null
          verification_status?: string
        }
        Update: {
          adapter_version?: string
          capabilities?: Json
          connection_id?: string | null
          created_at?: string
          environment?: string
          exchange?: string
          exchange_response_code?: string | null
          expires_at?: string | null
          id?: string
          market_type?: string
          position_mode?: string
          retrieved_at?: string
          source?: string
          symbol?: string | null
          updated_at?: string
          user_id?: string | null
          verification_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_capabilities_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "active_bot_config"
            referencedColumns: ["connection_id"]
          },
          {
            foreignKeyName: "venue_capabilities_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_capability_audit: {
        Row: {
          connection_id: string | null
          created_at: string
          detail: Json
          event: string
          exchange: string
          id: string
          reason_code: string
          user_id: string | null
        }
        Insert: {
          connection_id?: string | null
          created_at?: string
          detail?: Json
          event: string
          exchange: string
          id?: string
          reason_code: string
          user_id?: string | null
        }
        Update: {
          connection_id?: string | null
          created_at?: string
          detail?: Json
          event?: string
          exchange?: string
          id?: string
          reason_code?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "venue_capability_audit_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "active_bot_config"
            referencedColumns: ["connection_id"]
          },
          {
            foreignKeyName: "venue_capability_audit_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      waitlist_signups: {
        Row: {
          consent: boolean
          created_at: string
          email: string
          id: string
          kind: string
          notes: string | null
          source: string | null
          user_agent: string | null
        }
        Insert: {
          consent?: boolean
          created_at?: string
          email: string
          id?: string
          kind: string
          notes?: string | null
          source?: string | null
          user_agent?: string | null
        }
        Update: {
          consent?: boolean
          created_at?: string
          email?: string
          id?: string
          kind?: string
          notes?: string | null
          source?: string | null
          user_agent?: string | null
        }
        Relationships: []
      }
      wallet_activation_events: {
        Row: {
          actor: string
          event: string
          from_state: Json | null
          id: string
          server_ts: string
          to_state: Json | null
          user_id: string
          wallet_id: string
        }
        Insert: {
          actor?: string
          event: string
          from_state?: Json | null
          id?: string
          server_ts?: string
          to_state?: Json | null
          user_id: string
          wallet_id: string
        }
        Update: {
          actor?: string
          event?: string
          from_state?: Json | null
          id?: string
          server_ts?: string
          to_state?: Json | null
          user_id?: string
          wallet_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wallet_activation_events_wallet_id_fkey"
            columns: ["wallet_id"]
            isOneToOne: false
            referencedRelation: "paper_wallets"
            referencedColumns: ["id"]
          },
        ]
      }
      wallet_connection_challenges: {
        Row: {
          chain: string
          challenge_text: string
          created_at: string
          expires_at: string
          id: string
          nonce_hash: string
          provider: string
          public_address: string
          used_at: string | null
          user_id: string
        }
        Insert: {
          chain: string
          challenge_text: string
          created_at?: string
          expires_at: string
          id?: string
          nonce_hash: string
          provider: string
          public_address: string
          used_at?: string | null
          user_id: string
        }
        Update: {
          chain?: string
          challenge_text?: string
          created_at?: string
          expires_at?: string
          id?: string
          nonce_hash?: string
          provider?: string
          public_address?: string
          used_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      wallet_connections: {
        Row: {
          apex_authorized: boolean
          assigned_exchange_connection_id: string | null
          chain: string
          connected_at: string | null
          created_at: string
          disconnected_at: string | null
          id: string
          is_active: boolean
          is_default: boolean
          label: string | null
          last_error: string | null
          last_error_at: string | null
          last_seen_at: string | null
          network: string
          provider: string
          public_address: string
          status: string
          updated_at: string
          user_id: string
          verified_at: string | null
        }
        Insert: {
          apex_authorized?: boolean
          assigned_exchange_connection_id?: string | null
          chain: string
          connected_at?: string | null
          created_at?: string
          disconnected_at?: string | null
          id?: string
          is_active?: boolean
          is_default?: boolean
          label?: string | null
          last_error?: string | null
          last_error_at?: string | null
          last_seen_at?: string | null
          network?: string
          provider: string
          public_address: string
          status?: string
          updated_at?: string
          user_id: string
          verified_at?: string | null
        }
        Update: {
          apex_authorized?: boolean
          assigned_exchange_connection_id?: string | null
          chain?: string
          connected_at?: string | null
          created_at?: string
          disconnected_at?: string | null
          id?: string
          is_active?: boolean
          is_default?: boolean
          label?: string | null
          last_error?: string | null
          last_error_at?: string | null
          last_seen_at?: string | null
          network?: string
          provider?: string
          public_address?: string
          status?: string
          updated_at?: string
          user_id?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "wallet_connections_assigned_exchange_connection_id_fkey"
            columns: ["assigned_exchange_connection_id"]
            isOneToOne: false
            referencedRelation: "active_bot_config"
            referencedColumns: ["connection_id"]
          },
          {
            foreignKeyName: "wallet_connections_assigned_exchange_connection_id_fkey"
            columns: ["assigned_exchange_connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      worker_commands: {
        Row: {
          claimed_at: string | null
          claimed_by: string | null
          command: string
          completed_at: string | null
          consumed_at: string | null
          correlation_id: string
          created_at: string
          error_message: string | null
          id: string
          params: Json
          result: Json | null
          status: string
          symbol: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          claimed_at?: string | null
          claimed_by?: string | null
          command: string
          completed_at?: string | null
          consumed_at?: string | null
          correlation_id?: string
          created_at?: string
          error_message?: string | null
          id?: string
          params?: Json
          result?: Json | null
          status?: string
          symbol?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          claimed_at?: string | null
          claimed_by?: string | null
          command?: string
          completed_at?: string | null
          consumed_at?: string | null
          correlation_id?: string
          created_at?: string
          error_message?: string | null
          id?: string
          params?: Json
          result?: Json | null
          status?: string
          symbol?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      worker_heartbeats: {
        Row: {
          environment: string
          health: Json
          last_seen_at: string
          mode: string
          status: string
          updated_at: string
          version: string | null
          worker_id: string
        }
        Insert: {
          environment?: string
          health?: Json
          last_seen_at?: string
          mode?: string
          status?: string
          updated_at?: string
          version?: string | null
          worker_id: string
        }
        Update: {
          environment?: string
          health?: Json
          last_seen_at?: string
          mode?: string
          status?: string
          updated_at?: string
          version?: string | null
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_heartbeats_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: true
            referencedRelation: "worker_registry"
            referencedColumns: ["worker_id"]
          },
        ]
      }
      worker_ingest_nonces: {
        Row: {
          expires_at: string
          nonce: string
          seen_at: string
          worker_id: string
        }
        Insert: {
          expires_at: string
          nonce: string
          seen_at?: string
          worker_id: string
        }
        Update: {
          expires_at?: string
          nonce?: string
          seen_at?: string
          worker_id?: string
        }
        Relationships: []
      }
      worker_registry: {
        Row: {
          active: boolean
          created_at: string
          description: string | null
          environment: string
          key_version: string
          updated_at: string
          worker_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          description?: string | null
          environment?: string
          key_version?: string
          updated_at?: string
          worker_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          description?: string | null
          environment?: string
          key_version?: string
          updated_at?: string
          worker_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      active_bot_config: {
        Row: {
          connection_id: string | null
          cross_margin: boolean | null
          enabled: boolean | null
          environment: string | null
          exchange_type: string | null
          market_type: string | null
          mode: string | null
          params: Json | null
          permission_trade: boolean | null
          permissions_verified: boolean | null
          status: string | null
          symbol: string | null
          user_id: string | null
        }
        Relationships: []
      }
      apex_execution_credentials_status: {
        Row: {
          active: boolean | null
          apex_account_id: string | null
          created_at: string | null
          credential_fingerprint: string | null
          encryption_key_version: number | null
          environment: string | null
          exchange_connection_id: string | null
          id: string | null
          last_verified_at: string | null
          revoked_at: string | null
          rotated_at: string | null
          user_id: string | null
          wallet_address: string | null
        }
        Insert: {
          active?: boolean | null
          apex_account_id?: string | null
          created_at?: string | null
          credential_fingerprint?: string | null
          encryption_key_version?: number | null
          environment?: string | null
          exchange_connection_id?: string | null
          id?: string | null
          last_verified_at?: string | null
          revoked_at?: string | null
          rotated_at?: string | null
          user_id?: string | null
          wallet_address?: string | null
        }
        Update: {
          active?: boolean | null
          apex_account_id?: string | null
          created_at?: string | null
          credential_fingerprint?: string | null
          encryption_key_version?: number | null
          environment?: string | null
          exchange_connection_id?: string | null
          id?: string | null
          last_verified_at?: string | null
          revoked_at?: string | null
          rotated_at?: string | null
          user_id?: string | null
          wallet_address?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "apex_execution_credentials_exchange_connection_id_fkey"
            columns: ["exchange_connection_id"]
            isOneToOne: false
            referencedRelation: "active_bot_config"
            referencedColumns: ["connection_id"]
          },
          {
            foreignKeyName: "apex_execution_credentials_exchange_connection_id_fkey"
            columns: ["exchange_connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      paper_agentic_performance: {
        Row: {
          degraded_participation: number | null
          expectancy: number | null
          full_participation: number | null
          gross_loss: number | null
          gross_profit: number | null
          losses: number | null
          net_pnl: number | null
          sample_size: number | null
          unattributed_trades: number | null
          user_id: string | null
          wins: number | null
        }
        Relationships: []
      }
      paper_ai_participation_metrics: {
        Row: {
          ai_unavailable: number | null
          degraded_1_of_3: number | null
          degraded_2_of_3: number | null
          full_3_of_3: number | null
          missing_trace_violations: number | null
          orchestrations: number | null
          trade_candidates: number | null
          user_id: string | null
          wait_decisions: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      register_synfutures_account: {
        Args: { p_user_id: string; p_wallet_id: string; p_setup_revision: number; p_owner_address: string; p_safe_address: string; p_module_address: string; p_safe_proxy_code_hash: string; p_module_code_hash: string; p_block_number: string; p_block_hash: string; p_block_time: string }
        Returns: Json
      }
      edit_autopilot_turtles: {
        Args: { workflow_id: string; expected_turtles: string[]; selected_turtles: string[] }
        Returns: undefined
      }
      _paper_assert_owner: { Args: { _user_id: string }; Returns: undefined }
      get_user_ai_council_runtime: {
        Args: { p_user_id: string }
        Returns: Json
      }
      award_bill_points: {
        Args: {
          _bill_id: string
          _points: number
          _reason: string
          _user_id: string
        }
        Returns: number
      }
      claim_live_recon_lease: {
        Args: { _connection_id: string; _ttl_secs?: number }
        Returns: boolean
      }
      claim_paper_engine_operation: {
        Args: { _fingerprint: string; _op_key: string; _user_id: string }
        Returns: {
          result: Json
          status: string
        }[]
      }
      claim_paper_tick: {
        Args: { _bucket?: string; _user_id: string }
        Returns: boolean
      }
      cleanup_paper_tick_leases: { Args: never; Returns: undefined }
      committee_cycles_retention_purge: {
        Args: { _days?: number }
        Returns: number
      }
      community_seats_used: { Args: { _community_id: string }; Returns: number }
      complete_paper_engine_operation: {
        Args: { _op_key: string; _result: Json; _user_id: string }
        Returns: undefined
      }
      confirmed_risk_capital: {
        Args: { p_connection_id: string; p_user_id: string }
        Returns: number
      }
      create_turtle_monitoring_wallets: {
        Args: { _user_id: string }
        Returns: {
          activated_at: string
          balance: number
          balance_source: string
          created: boolean
          created_at: string
          direction_scope: string
          environment: string
          execution_enabled: boolean
          id: string
          monitor_role: string
          status: string
          wallet_key: string
        }[]
      }
      emit_ops_event: {
        Args: {
          _component: string
          _correlation_id: string
          _detail?: Json
          _latency_ms?: number
          _message: string
          _severity: string
          _stage: string
        }
        Returns: string
      }
      ensure_paper_ready: { Args: { _user_id: string }; Returns: undefined }
      ensure_paper_wallets: { Args: { _user_id: string }; Returns: undefined }
      exchange_connection_exists: {
        Args: { _connection_id: string }
        Returns: boolean
      }
      get_production_worker_health: {
        Args: never
        Returns: {
          credentials_ok: boolean | null
          environment: string
          last_seen_at: string
          mode: string
          status: string
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      invoke_paper_tick: { Args: never; Returns: undefined }
      is_community_leader: { Args: { _community_id: string }; Returns: boolean }
      is_community_member: { Args: { _community_id: string }; Returns: boolean }
      is_connection_slot_available: {
        Args: { _user_id: string }
        Returns: boolean
      }
      is_execution_halted: {
        Args: { p_connection_id: string; p_user_id: string }
        Returns: boolean
      }
      my_confirmed_risk_capital: {
        Args: { p_connection_id: string }
        Returns: number
      }
      my_connection_slot_available: { Args: never; Returns: boolean }
      my_ensure_paper_ready: { Args: never; Returns: boolean }
      my_execution_halted: {
        Args: { p_connection_id?: string }
        Returns: boolean
      }
      my_point_awards: {
        Args: { p_limit?: number }
        Returns: {
          awarded_at: string
          billing_period: string | null
          category_id: string | null
          entry_type: string
          id: string
          idempotency_key: string
          milestone_code: string
          points: number
          source_history_id: string | null
          user_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "point_awards"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      my_points_total: { Args: never; Returns: number }
      my_risk_capital_summary: {
        Args: never
        Returns: {
          allocated: number
          connection_id: string
          status: string
        }[]
      }
      owns_exchange_connection: {
        Args: { _connection_id: string }
        Returns: boolean
      }
      paper_add_rung:
        | {
            Args: {
              _expected_rung_count: number
              _new_state: Json
              _position_id: string
              _user_id: string
            }
            Returns: Json
          }
        | {
            Args: {
              _expected_rung_count: number
              _new_state: Json
              _position_id: string
              _rung_fills?: Json
              _user_id: string
            }
            Returns: Json
          }
      paper_assign_execution_slot: {
        Args: {
          _correlation_id: string
          _direction: string
          _symbol: string
          _ttl_secs?: number
          _user_id: string
        }
        Returns: string
      }
      paper_authorize_and_reserve: {
        Args: {
          _authorization_id: string
          _ttl_secs?: number
          _user_id: string
        }
        Returns: Json
      }
      paper_bind_pod_and_reserve_leg: {
        Args: {
          _authorization_id: string
          _purpose?: string
          _ttl_secs?: number
          _user_id: string
        }
        Returns: Json
      }
      paper_close_position: {
        Args: {
          _account_delta: number
          _last_seen_candle_ts_ms: number
          _position_id: string
          _trades: Json
          _user_id: string
          _wallet_id: string
          _wallet_stats: Json
        }
        Returns: Json
      }
      paper_ensure_symbol_pods: {
        Args: {
          _connection_id: string
          _environment: Database["public"]["Enums"]["scout_environment"]
          _exchange: string
          _market_type: Database["public"]["Enums"]["scout_market_type"]
          _run_id: string
          _user_id: string
        }
        Returns: Json
      }
      paper_open_position: {
        Args: { _payload: Json; _user_id: string; _wallet_id: string }
        Returns: Json
      }
      paper_partial_close_position: {
        Args: {
          _account_delta: number
          _last_seen_candle_ts_ms: number
          _margin_delta: number
          _position_id: string
          _position_patch: Json
          _size_notional_delta: number
          _size_qty_delta: number
          _trade: Json
          _user_id: string
          _wallet_id: string
          _wallet_stats: Json
        }
        Returns: Json
      }
      paper_pod_has_valid_leg_pair: {
        Args: { _pod_id: string }
        Returns: boolean
      }
      paper_reduce_position: {
        Args: {
          _account_delta: number
          _expected_rung_count: number
          _new_state: Json
          _position_id: string
          _trade: Json
          _user_id: string
          _wallet_id: string
          _wallet_stats: Json
        }
        Returns: Json
      }
      paper_release_execution_slot: {
        Args: { _reason?: string; _slot_id: string; _user_id: string }
        Returns: boolean
      }
      paper_release_wallet_leg: {
        Args: { _leg_id: string; _reason?: string; _user_id: string }
        Returns: boolean
      }
      paper_reset_epoch: {
        Args: {
          p_hedge_reserve?: number
          p_reason?: string
          p_recovery_reserve?: number
          p_run_id: string
        }
        Returns: Json
      }
      paper_sweep_expired_slot_reservations: {
        Args: { _user_id?: string }
        Returns: number
      }
      record_ops_snapshot: {
        Args: {
          _backlog_count: number
          _component: string
          _detail?: Json
          _freshness_ms: number
          _last_success_at: string
          _p50_latency_ms: number
          _p95_latency_ms: number
          _reasons: Json
          _state: string
        }
        Returns: string
      }
      redeem_community_invitation: {
        Args: { _email?: string; _token_hash: string }
        Returns: Json
      }
      release_live_recon_lease: {
        Args: { _connection_id: string }
        Returns: undefined
      }
      reset_paper_environment: { Args: never; Returns: Json }
      scout_persist_scan: {
        Args: {
          _entries: Json
          _evidence_schema_version: number
          _now_ms: number
          _rules_version: number
          _scan_id: string
        }
        Returns: Json
      }
      scout_retention_purge: {
        Args: { _days?: number }
        Returns: {
          evidence_deleted: number
          transitions_deleted: number
        }[]
      }
    }
    Enums: {
      account_mode: "spot" | "futures"
      app_role: "admin" | "moderator" | "user"
      bot_status: "running" | "paused"
      commission_kind: "fixed_amount" | "percent_of_revenue"
      community_member_role: "member" | "leader"
      community_member_status: "active" | "suspended" | "removed"
      community_status: "applied" | "approved" | "suspended" | "revoked"
      connection_status:
        | "connected"
        | "error"
        | "disconnected"
        | "unsupported"
        | "pending_verification"
        | "not_connected"
        | "verifying"
        | "verified"
        | "needs_attention"
        | "disabled"
        | "paused"
      entitlement_source: "grandfathered" | "invitation" | "admin_grant"
      market_support: "spot" | "futures" | "both"
      order_intent_state:
        | "previewed"
        | "confirmed"
        | "queued"
        | "signing"
        | "submitted"
        | "open"
        | "partially_filled"
        | "filled"
        | "cancellation_pending"
        | "cancelled"
        | "rejected"
        | "reconciliation_required"
        | "failed"
      paper_slot_state:
        | "unassigned"
        | "reserved"
        | "committed"
        | "active"
        | "hedge_reserved"
        | "recovery_reserved"
      position_side: "long" | "short"
      position_status: "open" | "closed"
      risk_level: "low" | "medium" | "high"
      scout_environment: "paper" | "testnet" | "mainnet"
      scout_market_type: "paper" | "futures" | "spot"
      scout_override_kind: "allow" | "deny" | "emergency_allow"
      scout_ranking_bucket: "watching" | "eligible" | "ranked" | "rejected"
      scout_universe_health: "healthy" | "degraded" | "offline" | "unverified"
      strategy_mode: "long" | "short"
      subscription_tier: "free" | "ion" | "arc" | "orb" | "zen"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      account_mode: ["spot", "futures"],
      app_role: ["admin", "moderator", "user"],
      bot_status: ["running", "paused"],
      commission_kind: ["fixed_amount", "percent_of_revenue"],
      community_member_role: ["member", "leader"],
      community_member_status: ["active", "suspended", "removed"],
      community_status: ["applied", "approved", "suspended", "revoked"],
      connection_status: [
        "connected",
        "error",
        "disconnected",
        "unsupported",
        "pending_verification",
        "not_connected",
        "verifying",
        "verified",
        "needs_attention",
        "disabled",
        "paused",
      ],
      entitlement_source: ["grandfathered", "invitation", "admin_grant"],
      market_support: ["spot", "futures", "both"],
      order_intent_state: [
        "previewed",
        "confirmed",
        "queued",
        "signing",
        "submitted",
        "open",
        "partially_filled",
        "filled",
        "cancellation_pending",
        "cancelled",
        "rejected",
        "reconciliation_required",
        "failed",
      ],
      paper_slot_state: [
        "unassigned",
        "reserved",
        "committed",
        "active",
        "hedge_reserved",
        "recovery_reserved",
      ],
      position_side: ["long", "short"],
      position_status: ["open", "closed"],
      risk_level: ["low", "medium", "high"],
      scout_environment: ["paper", "testnet", "mainnet"],
      scout_market_type: ["paper", "futures", "spot"],
      scout_override_kind: ["allow", "deny", "emergency_allow"],
      scout_ranking_bucket: ["watching", "eligible", "ranked", "rejected"],
      scout_universe_health: ["healthy", "degraded", "offline", "unverified"],
      strategy_mode: ["long", "short"],
      subscription_tier: ["free", "ion", "arc", "orb", "zen"],
    },
  },
} as const
