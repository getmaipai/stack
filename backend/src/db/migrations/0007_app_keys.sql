CREATE TABLE `app_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`hash` text NOT NULL,
	`scopes_json` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`last_used_at` text,
	`use_count` integer DEFAULT 0 NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_keys_hash_unique` ON `app_keys` (`hash`);
