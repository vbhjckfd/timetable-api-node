import db from '../connections/timetableSqliteDb.js';
import _ from 'lodash';

export default async (req, res, next) => {
    const routesRaw = db.getCollection('routes')
        .chain()
        .find({})
        .simplesort('short_name')
        .data()
    ;



    let result = `
        <style>
        table {border-collapse: collapse;}
        table, th{
            text-align: left;
        }
        table tr {border-bottom: 1pt solid black;}
        table td {vertical-align: top;}
        a {
            text-decoration: none;
        }
        </style>
        <table>
    `;
    for (let r of routesRaw) {

        const allStops = _(db.getCollection('stops').find({
            code: {
                $in: Object.values(r.stops_by_shape).flat()
            }
        })).keyBy('code').value();

        let stopsByShape = []
        for (const key of [0, 1]) {
            stopsByShape[key] = _(r.stops_by_shape[String(key)])
                .filter(st => !!allStops[st])
                .map(st => allStops[st])
                .map(s => ({code: s.code, name: s.name}))
                .map(s => `<li>${s.name} (<a target="_blank" href="https://lad.lviv.ua/${s.code}">${s.code}</a>)</li>`)
                .value()
                .join('');
        }

      result += `<tr>
        <td><a target="_blank" href="https://lad.lviv.ua/route/${r.external_id}">${r.short_name}</a></td>
        <td>${r.long_name}</td>
        <td><ol>${stopsByShape[0]}</ol></td>
        <td><ol>${stopsByShape[1]}</ol></td>
        </tr>`;
    }
    result += '</table>';

    res
        .set('Cache-Control', `public, max-age=0, s-maxage=3600`)
        .send(result)
    ;
}