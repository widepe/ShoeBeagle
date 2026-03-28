const { Pool } = require('pg');

module.exports = async (req, res) => {
  try {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });

    const result = await pool.query('SELECT * FROM sb_shoe_database LIMIT 5');

    res.status(200).json({ success: true, rows: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
