GRANT SELECT ON public.paper_execution_slots TO authenticated;
GRANT SELECT ON public.paper_epochs TO authenticated;
GRANT ALL ON public.paper_execution_slots TO service_role;
GRANT ALL ON public.paper_epochs TO service_role;