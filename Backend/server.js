const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 3642;

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL connection with retry configuration
const poolConfig = {
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'postgres',
  database: process.env.DB_NAME || 'bonus_proposals',
  password: process.env.DB_PASSWORD || 'admin123',
  port: process.env.DB_PORT || 5432,
  retry: {
    max: 5,
    timeout: 5000
  }
};

const pool = new Pool(poolConfig);

// Database health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'healthy' });
  } catch (err) {
    res.status(500).json({ status: 'unhealthy', error: err.message });
  }
});

// Get all bonus proposals
app.get('/api/bonuses', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bonus_proposals ORDER BY proposal_date DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching bonuses:', err.stack);
    res.status(500).json({ error: 'Server error while fetching bonuses' });
  }
});

// Get bonus proposals by employee ID with name validation
app.get('/api/bonuses/search', async (req, res) => {
  const { employeeName, employeeID } = req.query;
  
  if (!employeeID) {
    return res.status(400).json({ error: 'Employee ID is required' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM bonus_proposals WHERE employee_id = $1 ORDER BY proposal_date DESC',
      [employeeID]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No matching bonus proposals found' });
    }

    // Verify employee name consistency if provided
    if (employeeName) {
      const mismatchedNames = result.rows.filter(
        row => row.employee_name.toLowerCase() !== employeeName.toLowerCase()
      );
      
      if (mismatchedNames.length > 0) {
        const existingName = result.rows[0].employee_name;
        return res.status(400).json({
          error: `Employee ID ${employeeID} is associated with ${existingName}. Please use the correct employee name.`,
          correctName: existingName
        });
      }
    }

    res.json(result.rows);
  } catch (err) {
    console.error('Error searching bonuses:', err.stack);
    res.status(500).json({ error: 'Server error while searching bonuses' });
  }
});

// Create a new bonus proposal
app.post('/api/bonuses', async (req, res) => {
  const { employeeName, employeeID, proposalDate, bonusAmount, reason } = req.body;

  // Validation
  if (!employeeName || !employeeID || !proposalDate || !bonusAmount || !reason) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  if (bonusAmount < 100) {
    return res.status(400).json({ error: 'Bonus amount must be at least 100' });
  }

  if (!/^ATS0(?!000)[0-9]{3}$/.test(employeeID)) {
    return res.status(400).json({ error: 'Employee ID must be in format ATS0XXX where XXX is 001-999' });
  }

  try {
    // Check for existing proposal in the same month
    const existingProposal = await pool.query(
      `SELECT id, employee_name FROM bonus_proposals
       WHERE employee_id = $1
       AND EXTRACT(MONTH FROM proposal_date) = EXTRACT(MONTH FROM $2::date)
       AND EXTRACT(YEAR FROM proposal_date) = EXTRACT(YEAR FROM $2::date)`,
      [employeeID, proposalDate]
    );

    if (existingProposal.rows.length > 0) {
      return res.status(400).json({ 
        error: 'Employee has already been submitted for this month',
        existingProposal: existingProposal.rows[0]
      });
    }

    // Check for name consistency with existing records
    const nameCheck = await pool.query(
      'SELECT employee_name FROM bonus_proposals WHERE employee_id = $1 LIMIT 1',
      [employeeID]
    );

    if (nameCheck.rows.length > 0 && 
        nameCheck.rows[0].employee_name.toLowerCase() !== employeeName.toLowerCase()) {
      return res.status(400).json({
        error: `Employee ID ${employeeID} is associated with ${nameCheck.rows[0].employee_name}`,
        correctName: nameCheck.rows[0].employee_name
      });
    }

    // Insert new proposal
    const result = await pool.query(
      `INSERT INTO bonus_proposals 
       (employee_name, employee_id, proposal_date, bonus_amount, reason) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [employeeName, employeeID, proposalDate, bonusAmount, reason]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating bonus:', err.stack);
    
    if (err.code === '23505') { // Unique violation
      return res.status(400).json({ error: 'Duplicate entry detected' });
    }
    
    res.status(500).json({ error: 'Server error while creating bonus' });
  }
});

// Database initialization with retry logic
async function initializeDatabase() {
  const maxRetries = 5;
  let retries = 0;

  while (retries < maxRetries) {
    try {
      console.log(`Attempting database connection (attempt ${retries + 1})`);
      
      // Test connection first
      await pool.query('SELECT 1');
      
      // Drop existing table if needed
      await pool.query('DROP TABLE IF EXISTS bonus_proposals CASCADE');

      // Create new table
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

      // Create unique index for monthly constraint
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS unique_employee_per_month
        ON bonus_proposals (employee_id, EXTRACT(YEAR FROM proposal_date), EXTRACT(MONTH FROM proposal_date))
      `);

      // Insert sample data if empty
      const countResult = await pool.query('SELECT COUNT(*) FROM bonus_proposals');
      if (parseInt(countResult.rows[0].count) === 0) {
        await pool.query(`
          INSERT INTO bonus_proposals 
          (employee_name, employee_id, proposal_date, bonus_amount, reason) VALUES
          ('Veera Raghava', 'ATS0123', '2025-04-24', 5000, 'Bonus for good performance and exceeding quarterly targets by 15% while maintaining excellent code quality standards.'),
          ('Pavan Kumar', 'ATS0456', '2025-04-20', 7500, 'Exceptional leadership in the recent product launch, coordinating between multiple teams to deliver ahead of schedule with outstanding results.');
        `);
        console.log('Sample data inserted');
      }

      console.log('Database initialized successfully');
      return;
    } catch (err) {
      retries++;
      console.error(`Database initialization failed (attempt ${retries}):`, err.message);
      
      if (retries < maxRetries) {
        console.log(`Retrying in 5 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      } else {
        throw new Error(`Failed to initialize database after ${maxRetries} attempts`);
      }
    }
  }
}

// Start server with database initialization
initializeDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
      console.log(`Database connection established to ${poolConfig.host}:${poolConfig.port}`);
    });
  })
  .catch(err => {
    console.error('Fatal error during initialization:', err);
    process.exit(1);
  });

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received. Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});
