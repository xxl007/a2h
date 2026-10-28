-- request_deliveries is append-only, like request_events, blocked_manifests
-- and answers (0001_append_only.sql): a delivery outcome is written once and
-- never changed. Hand-written (drizzle-kit generate --custom).
CREATE TRIGGER request_deliveries_append_only BEFORE UPDATE OR DELETE ON request_deliveries FOR EACH ROW EXECUTE FUNCTION a2h_append_only();
--> statement-breakpoint
CREATE TRIGGER request_deliveries_no_truncate BEFORE TRUNCATE ON request_deliveries FOR EACH STATEMENT EXECUTE FUNCTION a2h_append_only();
