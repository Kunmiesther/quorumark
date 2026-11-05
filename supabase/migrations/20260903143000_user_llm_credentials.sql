create extension if not exists supabase_vault with schema vault;
create table if not exists public.user_llm_credentials (
 user_id uuid not null references auth.users(id) on delete cascade,
 provider text not null check (provider in ('openai','anthropic','google')),
 vault_secret_id uuid not null,
 key_last_four text not null check (char_length(key_last_four)=4),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key(user_id,provider)
);
alter table public.user_llm_credentials enable row level security;
revoke all on table public.user_llm_credentials from anon,authenticated;
grant select,insert,update,delete on table public.user_llm_credentials to service_role;
create or replace function public.store_user_llm_credential(p_user_id uuid,p_provider text,p_secret text)
returns void language plpgsql security definer set search_path='' as $$
declare sid uuid; nid uuid;
begin
 if p_user_id is null or p_provider not in ('openai','anthropic','google') or char_length(trim(p_secret))<8 then raise exception 'invalid credential input'; end if;
 select vault_secret_id into sid from public.user_llm_credentials where user_id=p_user_id and provider=p_provider for update;
 if sid is null then
  select vault.create_secret(p_secret,'llm:'||p_user_id::text||':'||p_provider,'TurtleBot user-owned '||p_provider||' API credential') into nid;
  insert into public.user_llm_credentials(user_id,provider,vault_secret_id,key_last_four) values(p_user_id,p_provider,nid,right(p_secret,4))
  on conflict(user_id,provider) do update set vault_secret_id=excluded.vault_secret_id,key_last_four=excluded.key_last_four,updated_at=now();
 else
  perform vault.update_secret(sid,p_secret);
  update public.user_llm_credentials set key_last_four=right(p_secret,4),updated_at=now() where user_id=p_user_id and provider=p_provider;
 end if;
end $$;
create or replace function public.delete_user_llm_credential(p_user_id uuid,p_provider text)
returns void language plpgsql security definer set search_path='' as $$
declare sid uuid;
begin
 select vault_secret_id into sid from public.user_llm_credentials where user_id=p_user_id and provider=p_provider for update;
 delete from public.user_llm_credentials where user_id=p_user_id and provider=p_provider;
 if sid is not null then delete from vault.secrets where id=sid; end if;
end $$;
revoke all on function public.store_user_llm_credential(uuid,text,text) from public,anon,authenticated;
revoke all on function public.delete_user_llm_credential(uuid,text) from public,anon,authenticated;
grant execute on function public.store_user_llm_credential(uuid,text,text) to service_role;
grant execute on function public.delete_user_llm_credential(uuid,text) to service_role;
