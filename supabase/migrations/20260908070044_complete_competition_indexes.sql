create index if not exists telegram_link_codes_user_idx
  on public.telegram_link_codes (user_id);
create index if not exists community_competition_campaigns_community_idx
  on public.community_competition_campaigns (community_id);
create index if not exists community_competition_scores_entry_idx
  on public.community_competition_score_snapshots (entry_id);
create index if not exists community_competition_scores_entry_scope_idx
  on public.community_competition_score_snapshots (entry_id, competition_id, user_id);
