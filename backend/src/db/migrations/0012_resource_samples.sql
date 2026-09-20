CREATE TABLE `resource_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`kind` text NOT NULL,
	`percent` integer,
	`used_bytes` integer,
	`total_bytes` integer,
	`devices` text
);
