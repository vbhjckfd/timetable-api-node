const gtfs = require('gtfs');
const mongoose = require('mongoose');
const _ = require('lodash');

const dbConfig = {
    user: process.env.MONGO_IMPORT_USER,
    pass: process.env.MONGO_IMPORT_PASSWORD,
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useFindAndModify: false
}

const normalizeRouteName = (routeName) => {
    let rawNumber = parseInt(routeName.replace(/\D/g,''));
    let prefix = 'А';

    if (routeName.startsWith('Т')) {
        // tram or trol
        prefix = (rawNumber >= 30) ? 'Тр' : 'Т';
        
    } else if (routeName.startsWith('Н')) {
        // night bus
        prefix = 'Н-А'
    }

    return prefix + ((rawNumber > 10) ? rawNumber : ('0' + rawNumber));
}

module.exports = async (req, res, next) => {
    mongoose.connect(process.env.MONGO_GTFS_URL, dbConfig);

    const routes = await gtfs.getRoutes();

    let route = _(routes).find((i) => {
        return i.route_short_name === normalizeRouteName(req.params.name);
    });

    let shapeIdsStat = [];

    const trips = await gtfs.getTrips({
        'route_id': route.route_id
    });
    
    trips.forEach((t) => {
        shapeIdsStat.push(t.shape_id);
    });

    let mostPopularShapes = _(shapeIdsStat)
        .countBy()
        .entries()
        .orderBy(_.last)
        .takeRight(2)
        .map(_.head)
        .value();

    const shapes = await gtfs.getShapes({
        'shape_id': {
            '$in': mostPopularShapes
        }
    });

    for (key in mostPopularShapes) {
        shapes[key] = _(shapes[key]).filter((data) => data.shape_id == mostPopularShapes[key]).value();
    }

    mongoose.connection.close();

    res
        .set('Cache-Control', `public, s-maxage=${60 * 60 * 24}`)
        .send({
            'color': '#' + route.route_color,
            'text_color': '#' + route.route_text_color,
            'route_short_name': route.route_short_name,
            'route_long_name': route.route_long_name,
            'shapes': shapes,
            // 'shapes': _(shapes).map((s) => { return s.map((point) => {
            //     return [point.shape_pt_lat, point.shape_pt_lon]
            // }) }).value()
        })
    ;
}