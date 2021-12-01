const timetableDb = require('../connections/timetableSqliteDb');

module.exports = async (req, res, next) => {
    await timetableDb.loadDatabase();

    const routesRaw = timetableDb.getCollection('routes')
        .chain()
        .find({})
        .simplesort('short_name')
        .data()
    ;

    let result = '<table>';
    for (let r of routesRaw) {
      result += `<tr>
        <td><a target="blank" href="https://lad.lviv.ua/route/${r.external_id}">${r.short_name}</a></td>
        <td>${r.long_name}</td>
        </tr>`;
    }
    result += '</table>';

    res
        .set('Cache-Control', `public, max-age=0, s-maxage=3600`)
        .send(result)
    ;
}