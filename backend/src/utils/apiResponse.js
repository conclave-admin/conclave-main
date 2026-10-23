function ok(res, data, status = 200) {
  if (res.req?.user?.id) return require('../services/privacy.service').present(data, res.req.user.id)
    .then(payload => res.status(status).json({ success: true, data: payload }));
  return res.status(status).json({ success: true, data });
}

function fail(res, message, status = 400, details) {
  return res.status(status).json({ success: false, message, details });
}

module.exports = { ok, fail };
