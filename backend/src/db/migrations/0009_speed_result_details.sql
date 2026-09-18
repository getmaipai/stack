ALTER TABLE `speed_results` ADD COLUMN `load_ms` integer;
--> statement-breakpoint
ALTER TABLE `speed_results` ADD COLUMN `measured_footprint_bytes` integer;
--> statement-breakpoint
ALTER TABLE `speed_results` ADD COLUMN `prompt_tps` integer;
--> statement-breakpoint
ALTER TABLE `speed_results` ADD COLUMN `context_length` integer;
