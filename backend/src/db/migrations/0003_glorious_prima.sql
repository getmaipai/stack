CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`level` text NOT NULL,
	`title` text NOT NULL,
	`data` text NOT NULL,
	`at` text NOT NULL,
	`read_at` text,
	`dismissed_at` text
);
--> statement-breakpoint
CREATE TABLE `repairs` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`action` text NOT NULL,
	`level` text DEFAULT 'passive' NOT NULL,
	`opened_at` text NOT NULL,
	`resolved_at` text
);
