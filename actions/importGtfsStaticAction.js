const gtfs = require('gtfs');

module.exports = async (req, res, next) => {

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

    res.send('Ok');
}