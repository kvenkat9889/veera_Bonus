const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const app = express();
const port = 3642;

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
  user: 'postgres',
  host: 'postgres',
  database: 'bonus_proposals',
  password: 'admin123',
  port: 5432,
});

// Get all bonus proposals
app.get('/api/bonuses', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bonus_proposals ORDER BY proposal_date DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});
// Get all bonus proposals by employee ID
app.get('/api/bonuses/search', async (req, res) => {
  const { employeeName, employeeID } = req.query;
  try {
    const result = await pool.query(
      'SELECT * FROM bonus_proposals WHERE employee_id = $1 ORDER BY proposal_date DESC',
      [employeeID]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No matching bonus proposals found' });
    }

    // Verify employee name consistency across all proposals
    if (employeeName) {
      const mismatchedNames = result.rows.filter(
        row => row.employee_name.toLowerCase() !== employeeName.toLowerCase()
      );
      if (mismatchedNames.length > 0) {
        const existingName = result.rows[0].employee_name; // Use the first name for consistency
        return res.status(400).json({
          error: `Employee ID ${employeeID} is associated with ${existingName}. Please use the correct employee name.`,
        });
      }
    }

    res.json(result.rows); // Return all matching proposals
  } catch (err) {
    console.error(err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get bonus proposal by name and ID
app.get('/api/bonuses/search', async (req, res) => {
  const { employeeName, employeeID } = req.query;
  try {
    const result = await pool.query(
      'SELECT * FROM bonus_proposals WHERE employee_id = $1',
      [employeeID]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No matching bonus proposals found' });
    }
    const proposal = result.rows[0];
    if (employeeName && proposal.employee_name.toLowerCase() !== employeeName.toLowerCase()) {
      return res.status(400).json({
        error: `Employee ID ${employeeID} is associated with ${proposal.employee_name}. Please use the correct employee name.`,
      });
    }
    res.json(proposal);
  } catch (err) {
    console.error(err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create a new bonus proposal
// Create a new bonus proposal
app.post('/api/bonuses', async (req, res) => {
  const { employeeName, employeeID, proposalDate, bonusAmount, reason } = req.body;
  try {
    // Check for existing proposal in the same month
    const checkMonthResult = await pool.query(
      `SELECT proposal_date, employee_name FROM bonus_proposals 
       WHERE employee_id = $1 
       AND EXTRACT(MONTH FROM proposal_date) = EXTRACT(MONTH FROM $2::date)
       AND EXTRACT(YEAR FROM proposal_date) = EXTRACT(YEAR FROM $2::date)`,
      [employeeID, proposalDate]
    );

    if (checkMonthResult.rows.length > 0) {
      return res.status(400).json({ error: 'Employee ID has already been submitted for this month' });
    }

    // Check if employee ID exists and verify employee name consistency
    const checkNameResult = await pool.query(
      'SELECT employee_name FROM bonus_proposals WHERE employee_id = $1 LIMIT 1',
      [employeeID]
    );

    if (checkNameResult.rows.length > 0) {
      const existingName = checkNameResult.rows[0].employee_name;
      if (existingName.toLowerCase() !== employeeName.toLowerCase()) {
        return res.status(400).json({
          error: `Employee ID ${employeeID} is associated with ${existingName}. Please use the same employee name.`,
        });
      }
    }

    const result = await pool.query(
      'INSERT INTO bonus_proposals (employee_name, employee_id, proposal_date, bonus_amount, reason) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [employeeName, employeeID, proposalDate, bonusAmount, reason]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err.stack);
    if (err.code === '23505') { // PostgreSQL unique violation error code
      return res.status(400).json({ error: 'Employee ID has already been submitted for this month' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

async function initializeDatabase() {
  try {
    // Drop the existing table to clear any previous constraints (optional, only if needed)
    await pool.query('DROP TABLE IF EXISTS bonus_proposals CASCADE');

    // Create the table without the problematic UNIQUE constraint
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bonus_proposals (
        id SERIAL PRIMARY KEY,
        employee_name VARCHAR(100) NOT NULL,
        employee_id VARCHAR(7) NOT NULL,
        proposal_date DATE NOT NULL,
        bonus_amount INTEGER NOT NULL,
        reason TEXT NOT NULL,
        CONSTRAINT valid_employee_id CHECK (employee_id ~ '^ATS0(?!000)[0-9]{3}$'),
        CONSTRAINT valid_bonus_amount CHECK (bonus_amount >= 100)
      )
    `);

    // Create a unique index to enforce one bonus per employee per month
    await pool.query(`
      CREATE UNIQUE INDEX unique_employee_per_month 
      ON bonus_proposals (employee_id, EXTRACT(YEAR FROM proposal_date), EXTRACT(MONTH FROM proposal_date))
    `);

    // Insert sample data if table is empty
    const countResult = await pool.query('SELECT COUNT(*) FROM bonus_proposals');
    if (parseInt(countResult.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO bonus_proposals (employee_name, employee_id, proposal_date, bonus_amount, reason) VALUES
        ('Veera Raghava', 'ATS0123', '2025-04-24', 5000, 'Bonus for good performance and exceeding quarterly targets by 15% while maintaining excellent code quality standards.'),
        ('Pavan Kumar', 'ATS0456', '2025-04-20', 7500, 'Exceptional leadership in the recent product launch, coordinating between multiple teams to deliver ahead of schedule with outstanding results.');
      `);
    }
  } catch (err) {
    console.error('Error initializing database:', err.stack);
    throw err; // Stop the server if database initialization fails
  }
}

// Start server
initializeDatabase().then(() => {
  app.listen(port, () => {
    console.log(`Server running at http://44.223.23.145:${port}`);
  });
});