const timetableDb = require('../connections/timetableSqliteDb');

module.exports = async (req, res, next) => {
    await timetableDb.loadDatabase();

    const stopsRaw = timetableDb.getCollection('stops')
        .chain()
        .find({})
        .simplesort('code')
        .data()
    ;

    let result = '<table>';
    for (let s of stopsRaw) {
      const loc = s.location.coordinates;
      result += `<tr>
        <td><a target="blank" href="https://lad.lviv.ua/stops/${s.code}">${s.code}</a></td>
        <td>${s.name}</td>
        <td><a target="blank" href="https://www.openstreetmap.org/?mlat=${loc[0]}&mlon=${loc[1]}#map=18/${loc[0]}/${loc[1]}">${loc[0]},${loc[1]}</a></td>
        </tr>`;
    }
    result += '</table>';

    res
        .set('Cache-Control', `public, max-age=0, s-maxage=3600`)
        .send(result)
    ;
}