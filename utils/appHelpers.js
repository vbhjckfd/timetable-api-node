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
            10,
            0
        ));
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

        return prefix + ((rawNumber > 10) ? rawNumber : ('0' + rawNumber));
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

        return name;
    },

    getTripDirectionMap: async (routeId) => {
        const trips = await gtfs.getTrips({
            'route_id': routeId
        });

        let tripShapeMap = {};
        let shapeIdsStat = [];
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
            .value();

        let res = {};
        for (tripId in tripShapeMap) {
            if (mostPopularShapes.includes(tripShapeMap[tripId])) {
                res[tripId] = mostPopularShapes.indexOf(tripShapeMap[tripId]);
            }
        }

        return res;
    }
}