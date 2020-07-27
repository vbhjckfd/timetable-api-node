const gtfs = require('gtfs');
const microgizService = require('../services/microgizService');

let Promise = require('bluebird');
const redisClient = Promise.promisifyAll(require("../services/redisClient"));

const STATIC_REFRESH_DATE_KEY = 'static-data-refreshed';

module.exports = async (req, res, next) => {
    if (req.query.drop_last_update) {
      redisClient.del(STATIC_REFRESH_DATE_KEY);
      return res.send('Key dropped');
    }

    const getLastUpdateLocalDate = () => {
      return redisClient
        .getAsync(STATIC_REFRESH_DATE_KEY)
        .then(data => data ? new Date(JSON.parse(data)) : null)
    }



    const [lastUpdateRemote, lastUpdateLocal] = await Promise.all([
      microgizService.getTimeOfLastStaticUpdate(),
      getLastUpdateLocalDate()
    ]);

    if ((lastUpdateLocal || new Date()).getTime() == lastUpdateRemote.getTime()) {
      return res.send('Still fresh!');
    }

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

    redisClient.set(STATIC_REFRESH_DATE_KEY, JSON.stringify(lastUpdateRemote));

    res.send('Refreshed');
}