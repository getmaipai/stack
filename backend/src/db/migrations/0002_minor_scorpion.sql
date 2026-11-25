CREATE TABLE `disks` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`root_path` text NOT NULL,
	`removable` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `disks_root_path_unique` ON `disks` (`root_path`);--> statement-breakpoint
ALTER TABLE `models` ADD `disk_id` text;