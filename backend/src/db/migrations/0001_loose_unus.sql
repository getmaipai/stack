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
	`model_path` text
);
