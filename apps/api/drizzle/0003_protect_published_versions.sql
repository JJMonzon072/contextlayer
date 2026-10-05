-- Published versions cannot be deleted (ADR 0016). 0002 only rejected UPDATE,
-- so a direct DELETE could still erase published history. Same SQLSTATE as the
-- UPDATE trigger. INSERT and the ON DELETE SET NULL of published_by (an UPDATE)
-- are unaffected; TRUNCATE does not fire row triggers and stays an
-- owner-level maintenance operation.
CREATE FUNCTION "guide_versions_reject_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'guide_versions rows cannot be deleted (guide %, version %)', OLD.guide_id, OLD.version
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "guide_versions_undeletable"
  BEFORE DELETE ON "guide_versions"
  FOR EACH ROW EXECUTE FUNCTION "guide_versions_reject_delete"();
