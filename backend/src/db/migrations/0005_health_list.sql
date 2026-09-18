ALTER TABLE repairs RENAME TO repairs_legacy;
--> statement-breakpoint
CREATE TABLE health (
  code text PRIMARY KEY NOT NULL,
  severity text NOT NULL,
  title text NOT NULL,
  text text NOT NULL,
  since text NOT NULL,
  cause text NOT NULL,
  fix text,
  learn_more text,
  resolved_at text,
  ignored_at text
);
--> statement-breakpoint
INSERT INTO health (code, severity, title, text, since, cause, fix, resolved_at)
SELECT id, CASE level WHEN 'immediate' THEN 'critical' ELSE 'warning' END, title, detail, opened_at, detail,
  json_object('label', 'Resolve', 'action', action), resolved_at
FROM repairs_legacy;
--> statement-breakpoint
DROP TABLE repairs_legacy;
