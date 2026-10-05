CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"origins" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "applications_origins_check" CHECK (cardinality("applications"."origins") between 1 and 20
        and array_position("applications"."origins", null) is null
        and array_to_string("applications"."origins", ',') ~ '^https?://[^/?#@,*[:space:]]+(,https?://[^/?#@,*[:space:]]+)*$'
        and array_to_string("applications"."origins", ',') = lower(array_to_string("applications"."origins", ',')))
);
--> statement-breakpoint
CREATE TABLE "guide_steps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"guide_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"body" jsonb NOT NULL,
	"target" jsonb,
	"url_pattern" jsonb,
	"placement" text DEFAULT 'auto' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guide_steps_position_check" CHECK ("guide_steps"."position" >= 0),
	CONSTRAINT "guide_steps_placement_check" CHECK ("guide_steps"."placement" in ('auto', 'top', 'right', 'bottom', 'left')),
	CONSTRAINT "guide_steps_body_check" CHECK (jsonb_typeof("guide_steps"."body") = 'object' and "guide_steps"."body" ? 'version'),
	CONSTRAINT "guide_steps_target_check" CHECK ("guide_steps"."target" is null or (jsonb_typeof("guide_steps"."target") = 'object' and "guide_steps"."target" ? 'version')),
	CONSTRAINT "guide_steps_url_pattern_check" CHECK ("guide_steps"."url_pattern" is null or jsonb_typeof("guide_steps"."url_pattern") = 'object')
);
--> statement-breakpoint
CREATE TABLE "guide_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"guide_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"guide_revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"published_by" uuid,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guide_versions_guide_id_version_key" UNIQUE("guide_id","version"),
	CONSTRAINT "guide_versions_version_check" CHECK ("guide_versions"."version" >= 1),
	CONSTRAINT "guide_versions_guide_revision_check" CHECK ("guide_versions"."guide_revision" >= 1),
	CONSTRAINT "guide_versions_snapshot_check" CHECK (jsonb_typeof("guide_versions"."snapshot") = 'object' and "guide_versions"."snapshot" ? 'version')
);
--> statement-breakpoint
CREATE TABLE "guides" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"start_url_pattern" jsonb,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "guides_status_check" CHECK ("guides"."status" in ('draft', 'published', 'archived')),
	CONSTRAINT "guides_archived_check" CHECK (("guides"."status" = 'archived') = ("guides"."archived_at" is not null)),
	CONSTRAINT "guides_revision_check" CHECK ("guides"."revision" >= 1),
	CONSTRAINT "guides_start_url_pattern_check" CHECK ("guides"."start_url_pattern" is null or jsonb_typeof("guides"."start_url_pattern") = 'object')
);
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guide_steps" ADD CONSTRAINT "guide_steps_guide_id_guides_id_fk" FOREIGN KEY ("guide_id") REFERENCES "public"."guides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guide_versions" ADD CONSTRAINT "guide_versions_guide_id_guides_id_fk" FOREIGN KEY ("guide_id") REFERENCES "public"."guides"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guide_versions" ADD CONSTRAINT "guide_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guides" ADD CONSTRAINT "guides_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guides" ADD CONSTRAINT "guides_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guides" ADD CONSTRAINT "guides_application_fk" FOREIGN KEY ("workspace_id","application_id") REFERENCES "public"."applications"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guides_workspace_list_idx" ON "guides" USING btree ("workspace_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "guides_application_list_idx" ON "guides" USING btree ("workspace_id","application_id","id" DESC NULLS LAST);