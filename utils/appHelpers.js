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

    getRouteType: (routeName) => {
        let type = 'bus';
        if (routeName.startsWith('Тр')) {
            type = 'trol';
        } else if (routeName.startsWith('Т')) {
            type = 'tram';
        }
        return type;
    },

    cleanUpStopName: (stopName) => {
        return stopName.replace(/(\([\-\d]+\))/gi, '').trim();
    },

    getDirectionByTrip: (tripId, routeModel) => {
        if (!tripId || !routeModel.trip_shape_map[tripId]) {
            return null;
        }

        const shapesSortedById = Object.keys(routeModel.shapes).sort((a, b) => a - b);
        return shapesSortedById.indexOf(routeModel.trip_shape_map[tripId]);
    },

    getTextWaitTime: (busArrivalTime) => {
        let minutesLeft = Math.round((busArrivalTime - new Date()) / 1000 / 60);
        return ((minutesLeft > 0) ? minutesLeft : '< 1') + 'хв';
    },

    formatRouteName: (name) => {
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
            ['shape_id']))
            .map(i => i.shape_id)
        );

        const existingShapeRaw = await gtfs.getShapes({
            shape_id: Array.from(tripsShapes)
        }, ['shape_id']);

        const existingShapeIds = new Set(
            Array.from(existingShapeRaw)
            .flat()
            .map(i => i.shape_id)
        );

        const trips = await gtfs.getTrips({
            route_id: routeId,
            shape_id: Array.from(existingShapeIds)
        }, ['shape_id']);

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

    getRouteColor: (routeName) => {
        switch (routeName.charAt(0)) {
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

                const rawNumber = routeName.match(/\d+/g).join('')
                return '#' + colorMap[rawNumber.toString()];
            break;
            case 'Н':
                return '#000000';
            break;
        }

        return '#0E4F95'
    },

    getSmapleTrips: (route) => {
        let sampleTrips = [];

        for (const [key, value] of Object.entries(route.trip_direction_map)) {
            sampleTrips[value] = key;
        }

        return sampleTrips;
    },

    shapes_by_direction: (route) => {
        let shapes = [];

        for (key in route.shape_direction_map) {
            shapes[route.shape_direction_map[key]] = route.shapes[key];
        }

        return shapes;
    }

}