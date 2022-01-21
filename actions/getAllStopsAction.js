const timetableDb = require('../connections/timetableSqliteDb');

module.exports = async (req, res, next) => {
    await timetableDb.loadDatabase();

    const stopsRaw = timetableDb.getCollection('stops')
        .chain()
        .find({})
        .simplesort('code')
        .data()
    ;

    res
        .set('Cache-Control', `public, max-age=0, s-maxage=3600`);

    if (req.path.endsWith('.json')) {
        res.json(
            stopsRaw.map(s => {
                const loc = s.location.coordinates;
                return {
                    code: s.code,
                    name: s.name,
                    location: [loc[0], loc[1]],
                    routes: s.transfers.map(i => {
                        return i['route']
                    }).sort()
                }
            })
        );
    } else {
        let result = '<table>';
        for (let s of stopsRaw) {
          const loc = s.location.coordinates;

          const transfers = s.transfers.map(i => {
            return i['route']
          }).sort()

          result += `<tr>
            <td><a target="blank" href="https://lad.lviv.ua/stops/${s.code}">${s.code}</a></td>
            <td>${s.name}</td>
            <td><a target="blank" href="https://www.openstreetmap.org/?mlat=${loc[0]}&mlon=${loc[1]}#map=18/${loc[0]}/${loc[1]}">${loc[0]},${loc[1]}</a></td>
            <td>${transfers.join(' ')}</td>
            </tr>`;
        }
        result += '</table>';

        res.send(result)
    }
}