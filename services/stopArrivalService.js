let _ = require('lodash');
const fetch = require('node-fetch');

const stopArrivalService = {
    
    getTimetableForStop: function(stop) {
        return fetch(`https://api.eway.in.ua/?login=${process.env.EASYWAY_API_USER}&password=${process.env.EASYWAY_API_PASS}&function=stops.GetStopInfo&city=lviv&id=${stop.easyway_id}&v=1.2`)
        .then(async (response) => {
            let data = await response.json();

            let directions = {};

            return _
                .chain(data.routes)
                .filter(item => item.timeSource === 'gps')
                .sortBy(i => {return i.timeLeft})
                .slice(0, 10)
                .map(item => {
                    let type = 'bus';
                    if (item.transportKey == 'trol') {
                        type = 'trol';
                    } else if (item.transportKey == 'tram') {
                        type = 'tram';
                    }

                    let prefix = 'A';
                    if (_(['trol', 'tram']).indexOf(type) > -1) {
                        prefix = 'T';
                    }
                    let title = prefix + item.title.replace('А', '');

                    if (!directions.hasOwnProperty(item.id)) {
                        directions[item.id] = item.directionTitle
                    }

                    return {
                        route: title,
                        vehicle_type: type,
                        lowfloor: item.handicapped,
                        end_stop: directions[item.id],
                        time_left: item.timeLeftFormatted,
                        longitude: 0,
                        latitude: 0,
                        number: 0
                    }
                })
            ;
        });
    }

}

module.exports = stopArrivalService;