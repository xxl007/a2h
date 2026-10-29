-- Append-only tables and forward-only signing keys (task 3.1). Hand-written
-- (drizzle-kit generate --custom): Drizzle has no trigger API. Objects are
-- created unqualified, in the schema the search_path names (design D2).
--
-- request_events, blocked_manifests, answers: no UPDATE, DELETE or TRUNCATE.
-- signing_keys: key_id, public_key, owner and created_at never change; status
-- moves forward only (active → rotated → revoked, active → revoked); a key is
-- never deleted, so old signatures stay verifiable by key_id.
CREATE FUNCTION a2h_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER request_events_append_only BEFORE UPDATE OR DELETE ON request_events FOR EACH ROW EXECUTE FUNCTION a2h_append_only();
--> statement-breakpoint
CREATE TRIGGER request_events_no_truncate BEFORE TRUNCATE ON request_events FOR EACH STATEMENT EXECUTE FUNCTION a2h_append_only();
--> statement-breakpoint
CREATE TRIGGER blocked_manifests_append_only BEFORE UPDATE OR DELETE ON blocked_manifests FOR EACH ROW EXECUTE FUNCTION a2h_append_only();
--> statement-breakpoint
CREATE TRIGGER blocked_manifests_no_truncate BEFORE TRUNCATE ON blocked_manifests FOR EACH STATEMENT EXECUTE FUNCTION a2h_append_only();
--> statement-breakpoint
CREATE TRIGGER answers_append_only BEFORE UPDATE OR DELETE ON answers FOR EACH ROW EXECUTE FUNCTION a2h_append_only();
--> statement-breakpoint
CREATE TRIGGER answers_no_truncate BEFORE TRUNCATE ON answers FOR EACH STATEMENT EXECUTE FUNCTION a2h_append_only();
--> statement-breakpoint
CREATE FUNCTION a2h_signing_key_forward_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'signing key: % refused; keys are rotated or revoked, never removed', TG_OP USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.key_id IS DISTINCT FROM OLD.key_id OR NEW.public_key IS DISTINCT FROM OLD.public_key
     OR NEW.participant_id IS DISTINCT FROM OLD.participant_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.rotated_at IS NOT NULL AND NEW.rotated_at IS DISTINCT FROM OLD.rotated_at)
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'signing key %: key_id, public_key, owner and recorded times are immutable', OLD.key_id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'active' AND NEW.status IN ('rotated', 'revoked'))
    OR (OLD.status = 'rotated' AND NEW.status = 'revoked')) THEN
    RAISE EXCEPTION 'signing key %: % to % is not allowed', OLD.key_id, OLD.status, NEW.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER signing_keys_forward_only BEFORE UPDATE OR DELETE ON signing_keys FOR EACH ROW EXECUTE FUNCTION a2h_signing_key_forward_only();
--> statement-breakpoint
CREATE TRIGGER signing_keys_no_truncate BEFORE TRUNCATE ON signing_keys FOR EACH STATEMENT EXECUTE FUNCTION a2h_signing_key_forward_only();
