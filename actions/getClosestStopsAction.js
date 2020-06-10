const timetableDb = require('../connections/timetableDb');
const StopModel = timetableDb.model('Stop');
const appHelpers = require("../utils/appHelpers");

module.exports = async (req, res, next) => {
    let latitude = parseFloat(req.query.latitude).toFixed(3);
    let longitude = parseFloat(req.query.longitude).toFixed(3);

    StopModel.find({
        location: {
            $near: {
                $maxDistance: 600, //meters
                $geometry: {
                    type: "Point",
                    coordinates: [longitude, latitude]
                }
            }
        }
    }).find((error, results) => {
        if (error) throw error;

        let cacheLine = `public, max-age=0, s-maxage=${appHelpers.secondsUntilImportDone()}, stale-while-revalidate=15`;
        if (!results.length) {
            cacheLine = 'no-cache'; // Do not cache if no stops around point
        }

        res
            .set('Cache-Control', cacheLine)
            .json(results.map(s => {
                return {
                    code: s.code,
                    name: s.name,
                    longitude: s.location.coordinates[0],
                    latitude: s.location.coordinates[1]
                };
            }))
        ;
    });

}