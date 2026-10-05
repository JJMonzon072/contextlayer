-- Constraints drizzle-kit cannot express (docs/data-model.md, sections 3.6 and 3.10).

-- Step positions are unique per guide, checked at COMMIT: replacing the ordered
-- list runs several statements (delete, update, insert) that collide midway.
ALTER TABLE "guide_steps"
  ADD CONSTRAINT "guide_steps_guide_id_position_key"
  UNIQUE ("guide_id", "position") DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

-- Published versions are immutable snapshots (ADR 0016). The only change
-- allowed is ON DELETE SET NULL anonymizing `published_by` when its account is
-- deleted; every other UPDATE is rejected.
CREATE FUNCTION "guide_versions_reject_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.published_by IS NULL
    AND (NEW.id, NEW.guide_id, NEW.version, NEW.guide_revision, NEW.snapshot, NEW.published_at)
      IS NOT DISTINCT FROM
      (OLD.id, OLD.guide_id, OLD.version, OLD.guide_revision, OLD.snapshot, OLD.published_at)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'guide_versions rows are immutable (guide %, version %)', OLD.guide_id, OLD.version
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "guide_versions_immutable"
  BEFORE UPDATE ON "guide_versions"
  FOR EACH ROW EXECUTE FUNCTION "guide_versions_reject_update"();
