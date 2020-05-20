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

        res
            .set('Cache-Control', 'public')
            .set('Expires', appHelpers.nextImportDate().toGMTString()) // Expire cache after night import is done
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