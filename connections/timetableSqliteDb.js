import loki from 'lokijs';

const db = new loki('./database/Timetable', {
    autoload: true,
    verbose: true,
    autoloadCallback: () => {
        console.log('Database loaded');
    },
});

export default db;