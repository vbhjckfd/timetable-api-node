import loki from "lokijs";

const db = new loki("./database/Timetable", {
  verbose: true,
});

export default db;
