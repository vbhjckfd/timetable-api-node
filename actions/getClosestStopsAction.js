const timetableDb = require('../connections/timetableDb');
const StopModel = timetableDb.model('Stop');

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

        res.json(results.map(s => {
            return {
                code: s.code,
                name: s.name,
                longitude: s.location.coordinates[0],
                latitude: s.location.coordinates[1]
            };
        })); 
    });

}