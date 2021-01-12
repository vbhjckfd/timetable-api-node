const gtfs = require('gtfs');
const config = require('./gtfs-import-config.json');

(async () => {
    config.agencies[0].exclude = [
        "stop_times", "shapes", "stops"
    ];

    await gtfs.import(config);
    console.log('Import Successful');
})();