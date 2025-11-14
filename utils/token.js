const jwt = require('jsonwebtoken');

function verifyToken(req, res, next) {
	const authHeader = req.headers['authorization'];
	const token = authHeader && authHeader.split(' ')[1];
	if (!token) return res.status(401).json({ message: 'No token provided' });

	try {
		const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
		req.user = decoded.data;
		next();
	} catch (err) {
		return res.status(403).json({ message: 'Invalid token' });
	}
}

module.exports = { verifyToken }
