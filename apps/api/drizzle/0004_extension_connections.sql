CREATE TABLE "extension_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"grant_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "extension_access_tokens_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "extension_access_tokens_hash_length" CHECK (octet_length("extension_access_tokens"."token_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "extension_auth_codes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"grant_id" uuid,
	CONSTRAINT "extension_auth_codes_code_hash_key" UNIQUE("code_hash"),
	CONSTRAINT "extension_auth_codes_code_hash_length" CHECK (octet_length("extension_auth_codes"."code_hash") = 32),
	CONSTRAINT "extension_auth_codes_client_id_check" CHECK ("extension_auth_codes"."client_id" ~ '^[a-p]{32}$'),
	CONSTRAINT "extension_auth_codes_challenge_check" CHECK ("extension_auth_codes"."code_challenge" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "extension_auth_codes_method_check" CHECK ("extension_auth_codes"."code_challenge_method" = 'S256'),
	CONSTRAINT "extension_auth_codes_expiry_check" CHECK ("extension_auth_codes"."expires_at" > "extension_auth_codes"."created_at")
);
--> statement-breakpoint
CREATE TABLE "extension_grants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "extension_grants_client_id_check" CHECK ("extension_grants"."client_id" ~ '^[a-p]{32}$'),
	CONSTRAINT "extension_grants_expiry_check" CHECK ("extension_grants"."expires_at" > "extension_grants"."created_at"),
	CONSTRAINT "extension_grants_revocation_check" CHECK (("extension_grants"."revoked_at" is null) = ("extension_grants"."revoked_reason" is null)),
	CONSTRAINT "extension_grants_revoked_reason_check" CHECK ("extension_grants"."revoked_reason" is null or "extension_grants"."revoked_reason" in ('disconnected', 'dashboard', 'refresh-reuse', 'code-replay', 'replaced'))
);
--> statement-breakpoint
CREATE TABLE "extension_refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"grant_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"parent_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "extension_refresh_tokens_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "extension_refresh_tokens_hash_length" CHECK (octet_length("extension_refresh_tokens"."token_hash") = 32)
);
--> statement-breakpoint
ALTER TABLE "extension_access_tokens" ADD CONSTRAINT "extension_access_tokens_grant_id_extension_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."extension_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_auth_codes" ADD CONSTRAINT "extension_auth_codes_grant_id_extension_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."extension_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_auth_codes" ADD CONSTRAINT "extension_auth_codes_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."workspace_members"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_grants" ADD CONSTRAINT "extension_grants_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."workspace_members"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_refresh_tokens" ADD CONSTRAINT "extension_refresh_tokens_grant_id_extension_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."extension_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_refresh_tokens" ADD CONSTRAINT "extension_refresh_tokens_parent_id_extension_refresh_tokens_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."extension_refresh_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extension_access_tokens_grant_idx" ON "extension_access_tokens" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "extension_auth_codes_member_idx" ON "extension_auth_codes" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "extension_auth_codes_grant_idx" ON "extension_auth_codes" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "extension_grants_user_idx" ON "extension_grants" USING btree ("user_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "extension_grants_member_idx" ON "extension_grants" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "extension_refresh_tokens_grant_idx" ON "extension_refresh_tokens" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "extension_refresh_tokens_parent_idx" ON "extension_refresh_tokens" USING btree ("parent_id");