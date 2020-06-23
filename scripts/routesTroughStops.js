const main = async () => {
    const mongoose = require('mongoose');
    const dotenv = require('dotenv');
    dotenv.config();

    const createCsvWriter = require('csv-writer').createObjectCsvWriter;

    const dbConfig = {
      user: process.env.MONGO_IMPORT_USER,
      pass: process.env.MONGO_IMPORT_PASSWORD,
      useNewUrlParser: true,
      useUnifiedTopology: true,
      useFindAndModify: false
    }
    mongoose.connect(process.env.MONGO_GTFS_URL, dbConfig);

    const timetableDb = require('../connections/timetableDb');
    const StopModel = timetableDb.model('Stop');

    let data = [];
    const stops = await StopModel.find({}).sort('code');
    stops.map(i => {
        const coord = i.location.coordinates;
        data.push({
            code: i.code,
            name: i.name,
            routes: i.transfers.map(t => t.route).join("\n"),
            url: `https://www.openstreetmap.org/?mlat=${coord[1]}&mlon=${coord[0]}#map=17/${coord[1]}/${coord[0]}`
        });
        return i;
    })

    const csvWriter = createCsvWriter({
        path: 'out.csv',
        header: [
          {id: 'code', title: 'Code'},
          {id: 'name', title: 'Name'},
          {id: 'routes', title: 'Routes'},
          {id: 'url', title: 'OSM'},
        ]
      });
    csvWriter.writeRecords(data)

    return mongoose.disconnect();
}

main();