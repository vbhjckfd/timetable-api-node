const geodist = require('geodist');

const timetableDb = require('../connections/timetableSqliteDb');

module.exports = async (req, res, next) => {
    const stopsCollection = timetableDb.getCollection('stops');

    const latitude = parseFloat(req.query.latitude).toFixed(3);
    const longitude = parseFloat(req.query.longitude).toFixed(3);

    const results = stopsCollection
    .find({})
    .filter(s => {
        const position = s.location.coordinates;

        const dist = geodist(
            {lat: position[0], lon: position[1]},
            {lat: latitude, lon: longitude},
            {unit: 'meters'}
        );

        return dist < 1000;
    })
    // .sort((a, b) => {
    //     const positionA = a.location.coordinates;
    //     const positionB = b.location.coordinates;

    //     const distA = geodist(
    //         {lat: positionA[0], lon: positionA[1]},
    //         {lat: latitude, lon: longitude},
    //         {unit: 'meters'}
    //     );

    //     const distB = geodist(
    //         {lat: positionB[0], lon: positionB[1]},
    //         {lat: latitude, lon: longitude},
    //         {unit: 'meters'}
    //     );


    //     return distA - distB;
    // });

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
                longitude: s.location.coordinates[1],
                latitude: s.location.coordinates[0]
            };
        }))
    ;
}