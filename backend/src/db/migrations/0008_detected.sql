CREATE TABLE `detected` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`where` text NOT NULL,
	`could_hold` text NOT NULL,
	`first_seen` text NOT NULL,
	`last_seen` text NOT NULL,
	`forgotten` integer DEFAULT 0 NOT NULL,
	`adopted` integer DEFAULT 0 NOT NULL,
	`target` text
);
