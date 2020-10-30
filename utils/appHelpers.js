const gtfs = require('gtfs');
const _ = require('lodash');

module.exports = {

    nextImportDate: () => {
        const now = new Date();
        return new Date(Date.UTC(
            now.getFullYear(),
            now.getMonth(),
            now.getDate() + 1,
            1,
            15,
            0
        ));
    },

    secondsUntilImportDone: () => {
        return Math.round((module.exports.nextImportDate() - new Date()) / 1000);
    },

    normalizeRouteName: (routeName) => {
        let rawNumber = parseInt(routeName.replace(/\D/g,''));
        let prefix = 'А';

        if (routeName.startsWith('Т') || routeName.startsWith('T')) {
            // tram or trol
            prefix = (rawNumber >= 20) ? 'Тр' : 'Т';

        } else if (routeName.startsWith('Н') || routeName.startsWith('H')) {
            // night bus
            prefix = 'Н-А'
        }

        return prefix + ((rawNumber >= 10) ? rawNumber : ('0' + rawNumber));
    },

    getRouteType: (route) => {
        let type = 'bus';
        if (route.route_short_name.startsWith('Тр')) {
            type = 'trol';
        } else if (route.route_short_name.startsWith('Т')) {
            type = 'tram';
        }
        return type;
    },

    cleanUpStopName: (stopName) => {
        return stopName.replace(/(\([\-\d]+\))/gi, '').trim();
    },

    getTextWaitTime: (busArrivalTime) => {
        let minutesLeft = Math.round((busArrivalTime - new Date()) / 1000 / 60);
        return ((minutesLeft > 0) ? minutesLeft : '< 1') + 'хв';
    },

    formatRouteName: (route) => {
        let name = route.route_short_name;

        if (name.startsWith('Тр')) {
            name = name.replace('Тр', 'Т');
        } else if (name.startsWith('Н-А')) {
            name = name.replace('Н-А', 'Н');
        }

        name = name.replace('-А', '');
        name = name.replace('а', '');

        return name;
    },

    getMostPopularShapes: async (routeId) => {
        const tripsShapes = new Set(
            (await gtfs.getTrips({
                route_id: routeId
            },
            {shape_id: 1, _id: 0}))
            .map(i => i.shape_id)
        );

        const existingShapeRaw = await gtfs.getShapes({
            shape_id: {
                '$in': Array.from(tripsShapes)
            }
        }, {shape_id: 1, _id: 0});

        const existingShapeIds = new Set(
            Array.from(existingShapeRaw)
            .flat()
            .map(i => i.shape_id)
        );

        const trips = await gtfs.getTrips({
            route_id: routeId,
            shape_id: {'$in': Array.from(existingShapeIds)}
        }, {shape_id: 1, trip_id: 1, _id: 0});

        const shapeIdsStat = trips.map(t => t.shape_id);

        return _(shapeIdsStat)
            .countBy()
            .entries()
            .orderBy(_.last)
            .takeRight(2)
            .map(_.head)
            .sort()
            .value();
    },

    getRouteColor: (route) => {
        switch (route.route_short_name.charAt(0)) {
            case 'Т':
                const colorMap = {
                    '33': '6F7C32',
                    '32': 'E51467',
                    '31': '229038',
                    '30': 'EF88AA',
                    '29': '323C8D',
                    '27': 'B0CB1F',
                    '25': 'E85222',
                    '24': 'E5E248',
                    '23': 'BD8260',
                    '22': '3E9B7D',
                    '09': '26602C',
                    '08': '9E9E9E',
                    '07': '0971B7',
                    '06': '954592',
                    '05': 'FECD27',
                    '04': '1CBBEE',
                    '03': '50B056',
                    '02': '93573D',
                    '01': 'E42D24',
                };

                const rawNumber = route.route_short_name.match(/\d+/g).join('')
                return '#' + colorMap[rawNumber.toString()];
            break;
            case 'Н':
                return '#000000';
            break;
        }

        return '#0E4F95'
    },

    getTripDirectionMap: async (routeId) => {
        const tripsShapes = new Set(
            (await gtfs.getTrips({
                route_id: routeId
            },
            {shape_id: 1, _id: 0}))
            .map(i => i.shape_id)
        );

        const existingShapeRaw = await gtfs.getShapes({
            shape_id: {
                '$in': Array.from(tripsShapes)
            }
        }, {shape_id: 1, _id: 0});

        const existingShapeIds = new Set(
            Array.from(existingShapeRaw)
            .flat()
            .map(i => i.shape_id)
        );

        let tripShapeMap = {};
        let shapeIdsStat = [];

        const trips = await gtfs.getTrips({
            route_id: routeId,
            shape_id: {'$in': Array.from(existingShapeIds)}
        }, {shape_id: 1, trip_id: 1, _id: 0});

        trips.forEach((t) => {
            tripShapeMap[t.trip_id] = t.shape_id;
            shapeIdsStat.push(t.shape_id);
        });

        let mostPopularShapes = _(shapeIdsStat)
            .countBy()
            .entries()
            .orderBy(_.last)
            .takeRight(2)
            .map(_.head)
            .sort()
            .value();

        let res = new Map();
        for (tripId in tripShapeMap) {
            if (mostPopularShapes.includes(tripShapeMap[tripId])) {
                res.set(tripId, mostPopularShapes.indexOf(tripShapeMap[tripId]));
            }
        }

        return res;
    }
}