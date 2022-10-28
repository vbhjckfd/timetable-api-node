import { getShapes, getTrips } from 'gtfs';
import _ from 'lodash';

function nextImportDate() {
    const now = new Date();
    return new Date(Date.UTC(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        1,
        15,
        0
    ));
}

export function secondsUntilImportDone() {
    return Math.round((nextImportDate() - new Date()) / 1000);
}

export function isLowFloor(trip, vehiclesLocation, routeLocal) {
    // const is_low_floor = !!trip?.wheelchair_accessible ?? false
    // if (is_low_floor) {
    //     return true;
    // }

    const type = getRouteType(routeLocal.short_name)

    const licensePlate = vehiclesLocation.vehicle.vehicle.licensePlate;

    // Electron trolleys and maybe some LAZs
    if (type == 'trol') {
        const intLicensePlate = parseInt(licensePlate);
        return intLicensePlate >= 100 && intLicensePlate < 512;
    }

    // Electron trams
    if (type == 'tram') {
        const intLicensePlate = parseInt(licensePlate);
        return (intLicensePlate >= 1218) || (intLicensePlate >= 1179 && intLicensePlate <= 1187);
    }

    // Electrons or MAZs
    if ([
        'А01', 'А03', 'А05', 'А06', 'А08a', 'А09', 'А10', 'А16',
        'А18', 'А19', 'А29', 'А40', 'А46', 'А47', 'А49', 'А52', 'А61'
    ].includes(routeLocal.short_name)) {
        return true
    }

    if ([
        'BC-4166-ET', 'BC-4167-ET', 'BC-4168-ET', 'BC-4169-ET',
        'BC-7306-EP', 'BC-7313-EP', 'BC-7342-EP', 'BC-7346-EP',

        'AC-8634-EM',
        'AC-4293-EM',
        'AC-4294-EM',
        'AC-8629-EM',
        'BC-0144-OC',
        'BC-0243-MC',
        'BC-0245-MC',
        'BC-1349-MC',
        'BC-1371-MC',
        'BC-8466-ME',
        'BC-8467-ME',
        'BC-8732-MI',
        'BC-8734-MI',
    ].includes(licensePlate)) {
        return true;
    }

    console.log(licensePlate)
    return false;
}

export function normalizeRouteName(routeName) {
    const rawNumber = parseInt(routeName.replace(/\D/g,''));
    let prefix = 'А';
    const isTramOrTrol = ['Т', 'T'].some(n => routeName.startsWith(n));
    const inNightBus = ['Н', 'H'].some(n => routeName.startsWith(n));

    if (isTramOrTrol) {
        // tram or trol
        prefix = (rawNumber >= 20) ? 'Тр' : 'Т';

    } else if (inNightBus) {
        // night bus
        prefix = 'Н-А'
    }

    let postfix = '';
    if (routeName.endsWith('а') || routeName.endsWith('А')) {
        postfix = 'a';
    }

    return prefix + ((rawNumber >= 10) ? rawNumber : ('0' + rawNumber)) + postfix;
}

export function getRouteType(routeName) {
    let type = 'bus';
    if (routeName.startsWith('Тр')) {
        type = 'trol';
    } else if (routeName.startsWith('Т')) {
        type = 'tram';
    }
    return type;
}

export function cleanUpStopName(stopName) {
    return stopName.replace(/(\([\-\d]+\))/gi, '').trim();
}

export function getDirectionByTrip(tripId, routeModel) {
    if (!tripId || !routeModel.trip_shape_map[tripId]) {
        return null;
    }

    const shapesSortedById = Object.keys(routeModel.shapes).sort((a, b) => a - b);
    return shapesSortedById.indexOf(routeModel.trip_shape_map[tripId]);
}

export function getTextWaitTime(busArrivalTime) {
    let minutesLeft = Math.round((busArrivalTime - new Date()) / 1000 / 60);
    return ((minutesLeft > 0) ? minutesLeft : '< 1') + 'хв';
}

export function formatRouteName(name) {
    if (name.startsWith('Тр')) {
        name = name.replace('Тр', 'Т');
    } else if (name.startsWith('Н-А')) {
        name = name.replace('Н-А', 'Н');
    }

    name = name.replace('-А', '');
    name = name.replace('а', '');

    return name;
}

export async function getMostPopularShapes(routeId) {
    const tripsShapes = new Set(
        (await getTrips({
            route_id: routeId
        },
        ['shape_id']))
        .map(i => i.shape_id)
    );

    const existingShapeRaw = await getShapes({
        shape_id: Array.from(tripsShapes)
    }, ['shape_id']);

    const existingShapeIds = new Set(
        Array.from(existingShapeRaw)
        .flat()
        .map(i => i.shape_id)
    );

    const trips = await getTrips({
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
}

export function getRouteColor(routeName) {
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
}

export function getSmapleTrips(route) {
    let sampleTrips = [];

    for (const [key, value] of Object.entries(route.trip_direction_map)) {
        sampleTrips[value] = key;
    }

    return sampleTrips;
}

export function shapes_by_direction(route) {
    let shapes = [];

    for (const key in route.shape_direction_map) {
        shapes[route.shape_direction_map[key]] = route.shapes[key];
    }

    return shapes;
}