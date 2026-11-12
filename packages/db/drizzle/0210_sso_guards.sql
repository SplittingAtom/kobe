-- KOBE-625 (spec sso-oidc-scim §10): SCIM tokens are revoked, never brought back. Custom, so
-- db:rebase keeps this SQL as written. The app role may UPDATE only last_used_at and revoked_at
-- (column grants from the tenancy registry) and has no DELETE; this trigger also holds for the
-- owner: a token's hash, provider, prefix and creation never change, and once revoked_at is set
-- it stays as it is (a revoked token never works again). Invoker rights, pinned search_path.
CREATE FUNCTION "public"."scim_tokens_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.prefix IS DISTINCT FROM OLD.prefix
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'scim_tokens: only last_used_at and revoked_at change';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'scim_tokens: revocation is final';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "scim_tokens_guard" BEFORE UPDATE ON "scim_tokens"
  FOR EACH ROW EXECUTE FUNCTION "public"."scim_tokens_guard"();
