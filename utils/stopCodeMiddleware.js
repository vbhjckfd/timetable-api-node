export default function validateStopCode(req, res, next) {
  const code = Number(req.params.code);
  if (!code) {
    res.status(400).send(`Bad argument, ${req.params.code} is not a number`);
    return;
  }
  req.stopCode = code;
  next();
}
