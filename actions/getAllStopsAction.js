const timetableDb = require('../connections/timetableDb');
const StopModel = timetableDb.model('Stop');

module.exports = async (req, res, next) => {
    const stopsRaw = await StopModel.find().sort({code: 'asc'});

    let result = '<table>';
    for (let s of stopsRaw) {
      const loc = s.location.coordinates;
      result += `<tr>
        <td><a target="blank" href="https://lad.lviv.ua/stops/${s.code}">${s.code}</a></td>
        <td>${s.name}</td>
        <td><a target="blank" href="https://www.openstreetmap.org/?mlat=${loc[1]}&mlon=${loc[0]}#map=18/${loc[1]}/${loc[0]}">${loc[1]},${loc[0]}</a></td>
        </tr>`;
    }
    result += '</table>';

    res
        .set('Cache-Control', `public, max-age=0, s-maxage=3600`)
        .send(result)
    ;
}