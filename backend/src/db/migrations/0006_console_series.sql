CREATE TABLE `usage_samples` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `at` text NOT NULL,
  `ability` text,
  `client_id` text,
  `model_id` text,
  `requests` integer DEFAULT 0 NOT NULL,
  `tokens_in` integer DEFAULT 0 NOT NULL,
  `tokens_out` integer DEFAULT 0 NOT NULL,
  `jobs` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_samples` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `at` text NOT NULL,
  `total_bytes` integer NOT NULL,
  `free_bytes` integer NOT NULL,
  `available_percent` integer NOT NULL,
  `pressure` text NOT NULL,
  `loaded_bytes` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `speed_results` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `at` text NOT NULL,
  `ability` text,
  `model_id` text,
  `engine` text,
  `first_token_ms` integer,
  `tokens_per_second` integer
);
