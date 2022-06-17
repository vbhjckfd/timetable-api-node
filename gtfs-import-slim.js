import { importGtfs } from 'gtfs';

import { readFile } from 'fs/promises';
const config = JSON.parse(
    await readFile(new URL('./gtfs-import-config.json', import.meta.url))
);

(async () => {
    config.agencies[0].exclude = [
        "stop_times", "shapes", "stops"
    ];

    await importGtfs(config);
    console.log('Import Successful');
})();