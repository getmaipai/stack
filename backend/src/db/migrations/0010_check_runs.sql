CREATE TABLE `check_runs` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `at` text NOT NULL,
  `ok` integer NOT NULL,
  `results` text NOT NULL,
  `fit_together_ok` integer NOT NULL,
  `fit_together_reason` text
);
