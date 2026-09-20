CREATE TABLE `health` (
	`code` text PRIMARY KEY NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`text` text NOT NULL,
	`since` text NOT NULL,
	`cause` text NOT NULL,
	`fix` text,
	`resolved_at` text,
	`ignored_at` text
);
--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`roles` text NOT NULL,
	`source` text NOT NULL,
	`provenance` text NOT NULL,
	`revision` text NOT NULL,
	`sha256` text,
	`size_bytes` integer,
	`licence` text,
	`engine_requirements` text NOT NULL,
	`installed_at` text,
	`verified_at` text,
	`host_identity` text,
	`first_boot_at` text NOT NULL,
	`model_path` text,
	`measured_footprint_bytes` integer,
	`measured_context_length` integer
);
