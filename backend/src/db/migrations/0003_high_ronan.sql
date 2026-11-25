CREATE TABLE `move_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`from_disk` text NOT NULL,
	`to_disk` text NOT NULL,
	`state` text NOT NULL,
	`old_path` text NOT NULL,
	`new_path` text NOT NULL,
	`bytes_done` integer DEFAULT 0 NOT NULL,
	`bytes_total` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
