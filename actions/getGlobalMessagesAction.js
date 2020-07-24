module.exports = async (req, res, next) => {
    res
        .set('Cache-Control', `private, max-age=0`)
        .send([])
}