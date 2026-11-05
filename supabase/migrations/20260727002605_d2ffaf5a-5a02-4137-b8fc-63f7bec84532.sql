SET session_replication_role = replica;
DELETE FROM public.apex_execution_credentials WHERE exchange_connection_id IN ('51a684c4-1d95-4766-b837-cfb425485b63','d0700a21-751b-4ffa-a7cb-d51359118e48');
DELETE FROM public.exchange_credentials WHERE connection_id IN ('51a684c4-1d95-4766-b837-cfb425485b63','d0700a21-751b-4ffa-a7cb-d51359118e48');
DELETE FROM public.exchange_connections WHERE id IN ('51a684c4-1d95-4766-b837-cfb425485b63','d0700a21-751b-4ffa-a7cb-d51359118e48');
SET session_replication_role = origin;