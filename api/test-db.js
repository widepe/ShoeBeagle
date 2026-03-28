const db = require('../lib/db');

module.exports = async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM sb_shoe_database LIMIT 5');
    res.status(200).json({ success: true, rows: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
