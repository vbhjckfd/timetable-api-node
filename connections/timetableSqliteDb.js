const loki = require('lokijs');

const db = new loki('./database/Timetable', {
    autoload: true,
    verbose: true,
    autoloadCallback: () => {
        console.log('Database loaded');
    },
});

module.exports = db;