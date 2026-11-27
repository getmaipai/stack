CREATE TABLE `media_segments` (
	`file_sha256` text PRIMARY KEY NOT NULL,
	`pipeline_version` text NOT NULL,
	`record_json` text NOT NULL,
	`source_path` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
