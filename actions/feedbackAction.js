module.exports = async (req, res, next) => {
    res
        .send({message: req.body.message || "fuck you"});
}