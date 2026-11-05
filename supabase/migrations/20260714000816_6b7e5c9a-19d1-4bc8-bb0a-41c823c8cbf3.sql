ALTER TYPE public.connection_status ADD VALUE IF NOT EXISTS 'not_connected';
ALTER TYPE public.connection_status ADD VALUE IF NOT EXISTS 'verifying';
ALTER TYPE public.connection_status ADD VALUE IF NOT EXISTS 'verified';
ALTER TYPE public.connection_status ADD VALUE IF NOT EXISTS 'needs_attention';
ALTER TYPE public.connection_status ADD VALUE IF NOT EXISTS 'disabled';