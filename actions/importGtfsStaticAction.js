const gtfs = require('gtfs');
const timetableDb = require('../connections/timetableDb');

module.exports = async (req, res, next) => {

    const StopModel = timetableDb.model('Stop');
    
    await gtfs.import({
      "agencies": [
        {
          "agency_key": "Microgiz",
          "url": "http://track.ua-gis.com/gtfs/lviv/static.zip",
          "exclude": [
            // "stop_times"
          ]
        }
      ]
    });
    
    let importedStops = await gtfs.getStops();
    let stopIds = [];

    for (stopRow of importedStops) {
        let code = stopRow.stop_name.match(/(\([\-\d]+\))/i);

        if (null === code) {
            code = stopRow.stop_code
        } else if (Array.isArray(code)) {
            code = code[0]
        }

        for (cleaner of ['(', ')']) {
            code = code.replace(cleaner, '')
        }
        code = Number(code);

        if (!code) {
            console.warn(stopRow);
            continue;
        }

        if ([83].includes(code)) {
            console.warn(`Manually skipped stop ${code}`);
            continue;
        }

        let stop_name = stopRow.stop_name;

        for (cleaner of [`00${code}`, `0${code}`, code, '()', '" "', '(Т6)', '(0)', 'уточнити' , /^"{1}/ , /\s+$/, "\\"]) {
            stop_name = stop_name.replace(cleaner, '')
        }
        stop_name = stop_name.replace('""', '"')

        let stopModel = await StopModel.findOne({code: code});

        const stopData = {
            code: code,
            name: stop_name,
            microgiz_id: stopRow.stop_id,
            location: {
                type: "Point",
                coordinates: stopRow.loc
            }
        };

        if (!stopModel) {
            stopModel = await StopModel.create(stopData);
        } else {
            stopModel.name = stopData.name;
            stopModel.microgiz_id = stopData.microgiz_id;
            stopModel.location = stopData.location;
            stopModel.save();
        }

        console.log(`Saved stop ${stopModel.code} - ${stopModel.name}`);
        stopIds.push(stopModel.id);
    }

    await StopModel.deleteMany({"_id" : { $nin : stopIds}})

    res.send('Ok');
}