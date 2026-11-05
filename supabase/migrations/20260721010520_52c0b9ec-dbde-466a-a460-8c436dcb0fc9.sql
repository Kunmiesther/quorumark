
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.paper_engine_operations FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.paper_engine_operations FROM anon;
REVOKE ALL ON public.paper_engine_operations FROM anon;
