// Shrink the sqlite DB produced by gtfs-import.js down to what the running
// service reads (trips, calendars, routes). The heavy tables are only needed
// while building the loki Timetable file, which by now is already written.
//
// Replaces the second `gtfs-import-slim.js` run in the Dockerfile's runtime
// stage: that re-downloaded static.zip, so a feed published between the two
// stages left Timetable and the sqlite DB describing different feeds.
//
// Tables are emptied rather than dropped so the schema matches what
// importGtfs creates with `exclude` (the gtfs library expects them to exist).
import Database from "better-sqlite3";
import { readFile } from "fs/promises";

const config = JSON.parse(
  await readFile(new URL("../gtfs-import-config.json", import.meta.url)),
);

const EMPTIED_TABLES = ["stop_times", "shapes", "stops", "agency"];

const db = new Database(
  new URL(`../${config.sqlitePath}`, import.meta.url).pathname,
);
for (const table of EMPTIED_TABLES) {
  db.prepare(`DELETE FROM "${table}"`).run();
}
db.exec("VACUUM");
db.close();

console.log(`Emptied ${EMPTIED_TABLES.join(", ")}`);
