ALTER TABLE `models` ADD `nickname` text;
--> statement-breakpoint
ALTER TABLE `models` ADD `group_id` text;
--> statement-breakpoint
CREATE TABLE `model_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `model_usage` (
	`model_id` text PRIMARY KEY NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`seconds_loaded` integer DEFAULT 0 NOT NULL,
	`peak_memory_bytes` integer DEFAULT 0 NOT NULL,
	`last_used_at` text
);
