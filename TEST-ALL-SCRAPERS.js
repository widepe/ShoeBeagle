// api/test-all-scrapers.js
// Single endpoint to test all scrapers in sequence
// Usage: curl -H "x-cron-secret: SECRET" https://shoebeagle.com/api/test-all-scrapers

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cronSecret = process.env.CRON_SECRET;
  const providedSecret = req.headers['x-cron-secret'] || 
                         req.headers.authorization?.replace('Bearer ', '');
  
  if (cronSecret && providedSecret !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const start = Date.now();
  const results = {};

  // Get base URL
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const baseUrl = `${proto}://${host}`;

  const scrapers = [
    'brooks-sale',
    'asics-sale',
    'shoebacca-clearance',
    'holabird-mens-road',
    'holabird-womens-road',
    'holabird-trail-unisex',
  ];

  const otherEndpoints = [
    'scrape-daily',
  ];

  console.log('[Test All] Starting sequential scraper tests...');

  // Run each scraper
  for (const scraper of scrapers) {
    try {
      console.log(`[Test All] Testing ${scraper}...`);
      
      const response = await fetch(`${baseUrl}/api/scrapers/${scraper}`, {
        headers: {
          'x-cron-secret': cronSecret,
        },
      });

      const data = await response.json();
      
      results[scraper] = {
        success: data.success || false,
        totalDeals: data.totalDeals || 0,
        duration: data.duration || 'unknown',
      };

      console.log(`[Test All] ${scraper}: ${data.success ? '✓' : '✗'} ${data.totalDeals || 0} deals`);
      
    } catch (error) {
      console.error(`[Test All] ${scraper} failed:`, error.message);
      results[scraper] = {
        success: false,
        error: error.message,
      };
    }

    // Small delay between scrapers
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Run other endpoints (scrape-daily)
  for (const endpoint of otherEndpoints) {
    try {
      console.log(`[Test All] Testing ${endpoint}...`);
      
      const response = await fetch(`${baseUrl}/api/${endpoint}`, {
        headers: {
          'x-cron-secret': cronSecret,
        },
      });

      const data = await response.json();
      
      results[endpoint] = {
        success: data.success || false,
        totalDeals: data.totalDeals || data.total || 0,
        duration: data.duration || 'unknown',
      };

      console.log(`[Test All] ${endpoint}: ${data.success ? '✓' : '✗'} ${data.totalDeals || data.total || 0} deals`);
      
    } catch (error) {
      console.error(`[Test All] ${endpoint} failed:`, error.message);
      results[endpoint] = {
        success: false,
        error: error.message,
      };
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Run merge
  console.log('[Test All] Running merge...');
  try {
    const response = await fetch(`${baseUrl}/api/merge-deals`, {
      headers: {
        'x-cron-secret': cronSecret,
      },
    });

    const data = await response.json();
    
    results['merge-deals'] = {
      success: data.success || false,
      totalDeals: data.totalDeals || 0,
      duration: data.duration || 'unknown',
    };

    console.log(`[Test All] merge-deals: ${data.success ? '✓' : '✗'} ${data.totalDeals || 0} total deals`);
    
  } catch (error) {
    console.error('[Test All] merge-deals failed:', error.message);
    results['merge-deals'] = {
      success: false,
      error: error.message,
    };
  }

  const totalDuration = Date.now() - start;

  // Calculate summary
  const successCount = Object.values(results).filter(r => r.success).length;
  const totalCount = Object.keys(results).length;

  console.log(`[Test All] Complete! ${successCount}/${totalCount} succeeded in ${totalDuration}ms`);

  return res.status(200).json({
    success: successCount === totalCount,
    summary: `${successCount}/${totalCount} scrapers succeeded`,
    totalDuration: `${totalDuration}ms`,
    results,
    timestamp: new Date().toISOString(),
  });
};
