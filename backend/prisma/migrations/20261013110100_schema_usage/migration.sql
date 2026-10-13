-- Keep the app role able to use the schema even if it is ever re-created (e.g. after a development reset,
-- which drops and re-creates "public" and with it the grant made by db/init/01-roles.sh).
GRANT USAGE ON SCHEMA public TO placement_app;
