import migration0000 from "./migrations/0000_shiny_tarantula.sql" with { type: "file" };
import migration0001 from "./migrations/0001_loose_unus.sql" with { type: "file" };
import migration0002 from "./migrations/0002_normal_jetstream.sql" with { type: "file" };
import migration0003 from "./migrations/0003_glorious_prima.sql" with { type: "file" };
import migration0004 from "./migrations/0004_fresh_la_nuit.sql" with { type: "file" };
import migration0005 from "./migrations/0005_health_list.sql" with { type: "file" };
import migration0006 from "./migrations/0006_console_series.sql" with { type: "file" };
import migration0007 from "./migrations/0007_model_groups.sql" with { type: "file" };
import migration0008 from "./migrations/0008_detected.sql" with { type: "file" };
import migration0009 from "./migrations/0009_speed_result_details.sql" with { type: "file" };
import snapshot0000 from "./migrations/meta/0000_snapshot.json" with { type: "file" };
import snapshot0001 from "./migrations/meta/0001_snapshot.json" with { type: "file" };
import snapshot0002 from "./migrations/meta/0002_snapshot.json" with { type: "file" };
import snapshot0003 from "./migrations/meta/0003_snapshot.json" with { type: "file" };
import snapshot0004 from "./migrations/meta/0004_snapshot.json" with { type: "file" };
import journal from "./migrations/meta/_journal.json" with { type: "file" };

export const migrationAssets: ReadonlyArray<readonly [string, string]> = [
  ["0000_shiny_tarantula.sql", migration0000],
  ["0001_loose_unus.sql", migration0001],
  ["0002_normal_jetstream.sql", migration0002],
  ["0003_glorious_prima.sql", migration0003],
  ["0004_fresh_la_nuit.sql", migration0004],
  ["0005_health_list.sql", migration0005],
  ["0006_console_series.sql", migration0006],
  ["0007_model_groups.sql", migration0007],
  ["0008_detected.sql", migration0008],
  ["0009_speed_result_details.sql", migration0009],
  ["meta/0000_snapshot.json", snapshot0000 as unknown as string],
  ["meta/0001_snapshot.json", snapshot0001 as unknown as string],
  ["meta/0002_snapshot.json", snapshot0002 as unknown as string],
  ["meta/0003_snapshot.json", snapshot0003 as unknown as string],
  ["meta/0004_snapshot.json", snapshot0004 as unknown as string],
  ["meta/_journal.json", journal as unknown as string],
];
