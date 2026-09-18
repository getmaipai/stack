CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`verified_at` text,
	`created_at` text NOT NULL,
	`last_error` text,
	`last_sent_at` text,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`paused_at` text
);
