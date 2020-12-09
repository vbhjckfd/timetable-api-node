const timetableDb = require('../connections/timetableDb');
const StopModel = timetableDb.model('Stop');

module.exports = async (req, res, next) => {
    const latitude = parseFloat(req.query.latitude).toFixed(2);
    const longitude = parseFloat(req.query.longitude).toFixed(2);

    StopModel.find({
        location: {
            $near: {
                $maxDistance: 1000, //meters
                $geometry: {
                    type: "Point",
                    coordinates: [longitude, latitude]
                }
            }
        }
    }).find((error, results) => {
        if (error) {
            console.error(error);

            return res.status(500).send(`Bad argument: ${JSON.stringify([latitude, longitude])}`);
        }

        let cacheLine = `public, max-age=0, s-maxage=${10 * 24 * 3600}, stale-while-revalidate=15`;
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