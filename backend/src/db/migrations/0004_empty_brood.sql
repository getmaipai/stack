CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`reach` text NOT NULL,
	`paused` integer DEFAULT 0 NOT NULL,
	`last_seen_at` text,
	`last_used_at` text,
	`paired_at` text,
	`key_fingerprint` text,
	`endpoint_json` text,
	`tools_json` text,
	`secret_ref` text,
	`created_at` text NOT NULL,
	`provenance` text NOT NULL,
	`hlc` text NOT NULL
);
