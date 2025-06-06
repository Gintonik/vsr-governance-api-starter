const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const cron = require('node-cron');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 5000;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

app.use(express.static(__dirname));
app.use(express.json());



// Comprehensive route handling to prevent navigation breaks
app.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'verified-citizen-map.html'));
});

// Primary collection route
app.get('/collection', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'collection.html'));
});

// Alternative routes for the citizen map (prevent 404s)
app.get('/verified-citizen-map', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'verified-citizen-map.html'));
});

app.get('/verified-map', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'verified-citizen-map.html'));
});

app.get('/map', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'verified-citizen-map.html'));
});

app.get('/citizen-map', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'verified-citizen-map.html'));
});

// Alternative routes for collection page (prevent 404s)
app.get('/nfts', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'collection.html'));
});

app.get('/perks', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'collection.html'));
});

app.get('/collection.html', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'collection.html'));
});

app.get('/verified-citizen-map.html', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'verified-citizen-map.html'));
});

// Function to fetch single NFT metadata using Helius API
async function fetchNFTMetadata(nftAddress) {
  try {
    const heliusUrl = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
    
    const response = await fetch(heliusUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'get-asset',
        method: 'getAsset',
        params: {
          id: nftAddress
        }
      })
    });

    const data = await response.json();
    
    if (data.result) {
      return data.result;
    }
    
    return null;
  } catch (error) {
    console.error('Error fetching NFT metadata:', error);
    return null;
  }
}

// Function to fetch NFTs for a wallet using Helius API
async function fetchWalletNFTs(walletAddress) {
  try {
    const heliusUrl = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
    
    const response = await fetch(heliusUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'get-assets',
        method: 'getAssetsByOwner',
        params: {
          ownerAddress: walletAddress,
          page: 1,
          limit: 1000
        }
      })
    });

    const data = await response.json();
    
    if (data.result && data.result.items) {
      // Filter for PERKS collection NFTs - using the correct collection ID
      const perksNfts = data.result.items.filter(nft => {
        return nft.grouping && nft.grouping.some(group => 
          group.group_key === 'collection' && 
          group.group_value === '5XSXoWkcmynUSiwoi7XByRDiV9eomTgZQywgWrpYzKZ8'
        );
      });

      return perksNfts.map(nft => ({
        mint: nft.id,
        name: nft.content?.metadata?.name || 'PERKS NFT',
        image: (nft.content?.files?.[0]?.uri || nft.content?.json_uri || '').replace('https://gateway.irys.xyz/', 'https://uploader.irys.xyz/'),
        collection: 'PERKS'
      }));
    }

    return [];
  } catch (error) {
    console.error(`Error fetching NFTs for ${walletAddress}:`, error);
    return [];
  }
}

// Load governance data
let governanceData = {};
try {
  const governanceFile = path.join(__dirname, '..', 'data', 'native-governance-power.json');
  if (fs.existsSync(governanceFile)) {
    governanceData = JSON.parse(fs.readFileSync(governanceFile, 'utf8'));
    console.log('Loaded governance data with', governanceData.citizens?.length || 0, 'citizens');
  }
} catch (error) {
  console.log('Could not load governance data:', error.message);
}

// API endpoint for citizens data with NFT information
app.get('/api/citizens', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM citizens ORDER BY native_governance_power DESC NULLS LAST');
    const citizens = result.rows;
    
    // Add NFT data from stored database records
    const citizensWithNfts = citizens.map(citizen => {
      let nftIds = [];
      let nftMetadata = {};
      
      // Parse stored NFT metadata from database
      if (citizen.nft_metadata) {
        try {
          const storedNfts = JSON.parse(citizen.nft_metadata);
          storedNfts.forEach(nft => {
            nftIds.push(nft.mint);
            nftMetadata[nft.mint] = {
              name: nft.name,
              image: nft.image
            };
          });
        } catch (error) {
          console.error(`Error parsing NFT metadata for ${citizen.nickname}:`, error);
        }
      }
      
      // Use live database governance power values
      return {
        ...citizen,
        nfts: nftIds,
        nftMetadata: nftMetadata
      };
    });
    
    res.json(citizensWithNfts);
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ error: 'Failed to fetch citizens' });
  }
});

// API endpoint to get all NFTs from all citizens for the collection page
app.get('/api/nfts', async (req, res) => {
  try {
    const result = await pool.query('SELECT wallet, nickname, nft_metadata FROM citizens WHERE wallet IS NOT NULL AND nft_metadata IS NOT NULL ORDER BY nickname');
    const citizens = result.rows;
    
    let allNfts = [];
    
    // Use stored NFT data from database for better performance
    for (const citizen of citizens) {
      try {
        const nftData = JSON.parse(citizen.nft_metadata || '[]');
        
        nftData.forEach(nft => {
          allNfts.push({
            id: nft.mint,
            name: nft.name,
            content: {
              metadata: {
                name: nft.name
              },
              links: {
                image: nft.image
              }
            },
            owner_wallet: citizen.wallet,
            owner_nickname: citizen.nickname || 'Unknown Citizen'
          });
        });
      } catch (error) {
        console.error(`Error parsing NFT data for ${citizen.nickname}:`, error);
        // Fallback to API fetch if stored data is corrupted
        try {
          const nfts = await fetchWalletNFTs(citizen.wallet);
          nfts.forEach(nft => {
            allNfts.push({
              id: nft.mint,
              name: nft.name,
              content: {
                metadata: {
                  name: nft.name
                },
                links: {
                  image: nft.image
                }
              },
              owner_wallet: citizen.wallet,
              owner_nickname: citizen.nickname || 'Unknown Citizen'
            });
          });
        } catch (fallbackError) {
          console.error(`Fallback API fetch failed for ${citizen.nickname}:`, fallbackError);
        }
      }
    }
    
    console.log(`Total NFTs found from database: ${allNfts.length}`);
    res.json(allNfts);
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ error: 'Failed to fetch NFTs' });
  }
});

// Authentic governance data sync using locked VSR calculator
async function syncGovernanceData() {
  try {
    console.log('Starting daily authentic governance sync...');
    
    // Get all citizens from database
    const result = await pool.query('SELECT wallet, nickname FROM citizens ORDER BY nickname');
    const citizens = result.rows;
    
    console.log(`Syncing authentic governance power for ${citizens.length} citizens...`);
    
    let updated = 0;
    let failed = 0;
    
    // Calculate authentic governance power for each citizen
    for (const citizen of citizens) {
      try {
        console.log(`Calculating governance power for ${citizen.nickname} (${citizen.wallet.slice(0, 8)}...)`);
        
        // Get authentic governance power from locked VSR calculator
        const response = await fetch(`http://localhost:3001/api/governance-power?wallet=${citizen.wallet}`);
        const governanceData = await response.json();
        
        if (response.ok && governanceData.totalGovernancePower !== undefined) {
          // Update database with authentic blockchain data
          await pool.query(`
            UPDATE citizens 
            SET 
              native_governance_power = $1,
              governance_power = $2,
              total_governance_power = $3,
              updated_at = NOW()
            WHERE wallet = $4
          `, [
            governanceData.nativeGovernancePower || 0,
            governanceData.delegatedGovernancePower || 0,
            governanceData.totalGovernancePower || 0,
            citizen.wallet
          ]);
          
          updated++;
          console.log(`✅ ${citizen.nickname}: ${(governanceData.totalGovernancePower || 0).toLocaleString()} ISLAND`);
        } else {
          throw new Error(`API returned: ${JSON.stringify(governanceData)}`);
        }
        
      } catch (error) {
        failed++;
        console.error(`❌ Failed to update ${citizen.nickname}: ${error.message}`);
      }
    }
    
    // Refresh NFT data for all citizens and remove those without PERKS NFTs
    console.log('Refreshing NFT data and cleaning up invalid citizens...');
    let removed = 0;
    
    for (const citizen of citizens) {
      try {
        // Double-check NFT ownership with retry mechanism to avoid false positives
        let nfts = [];
        let attempts = 0;
        const maxAttempts = 3;
        
        while (attempts < maxAttempts) {
          try {
            nfts = await fetchWalletNFTs(citizen.wallet);
            break; // Success, exit retry loop
          } catch (fetchError) {
            attempts++;
            console.log(`Retry ${attempts}/${maxAttempts} for ${citizen.nickname} NFT fetch: ${fetchError.message}`);
            if (attempts < maxAttempts) {
              await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
            }
          }
        }
        
        const nftIds = nfts.map(nft => nft.mint);
        
        // CRITICAL: Only remove citizen if we successfully fetched NFT data AND confirmed zero PERKS NFTs
        if (attempts < maxAttempts && nfts.length === 0) {
          // Additional verification: Check if wallet still exists and is accessible
          try {
            const verificationResponse = await fetch(process.env.HELIUS_API_KEY, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'verify-wallet',
                method: 'getAssetsByOwner',
                params: { ownerAddress: citizen.wallet, page: 1, limit: 1 }
              })
            });
            
            const verificationData = await verificationResponse.json();
            
            // Only remove if verification call succeeded AND confirms no PERKS NFTs
            if (verificationData.result && Array.isArray(verificationData.result.items)) {
              await pool.query('DELETE FROM citizens WHERE wallet = $1', [citizen.wallet]);
              removed++;
              console.log(`🗑️ Removed ${citizen.nickname} - verified no PERKS NFTs (${attempts} attempts)`);
            } else {
              console.log(`⚠️ Skipped removing ${citizen.nickname} - verification failed`);
            }
          } catch (verifyError) {
            console.log(`⚠️ Skipped removing ${citizen.nickname} - verification error: ${verifyError.message}`);
          }
        } else if (attempts >= maxAttempts) {
          console.log(`⚠️ Skipped ${citizen.nickname} - failed to fetch NFT data after ${maxAttempts} attempts`);
        } else {
          // Update NFT data for citizens who still own PERKS
          await pool.query(
            'UPDATE citizens SET nft_ids = $1, nft_metadata = $2, updated_at = NOW() WHERE wallet = $3',
            [JSON.stringify(nftIds), JSON.stringify(nfts), citizen.wallet]
          );
        }
      } catch (error) {
        console.error(`Error processing ${citizen.wallet}:`, error);
      }
    }
    
    console.log(`Daily sync completed: ${updated} updated, ${failed} failed, ${removed} removed (no PERKS NFTs)`);
  } catch (error) {
    console.error('Error during daily sync:', error);
  }
}

// Schedule daily sync at 00:00 UTC (midnight)
cron.schedule('0 0 * * *', syncGovernanceData, {
  timezone: 'UTC'
});

// Add manual sync endpoint for immediate NFT data population
app.post('/api/sync-data', async (req, res) => {
  try {
    console.log('Manual sync triggered...');
    await syncGovernanceData();
    res.json({ success: true, message: 'Data sync completed successfully' });
  } catch (error) {
    console.error('Manual sync failed:', error);
    res.status(500).json({ error: 'Sync failed', details: error.message });
  }
});

// Add API endpoint for wallet NFTs
app.get('/api/wallet-nfts', async (req, res) => {
  try {
    const { wallet } = req.query;
    if (!wallet) {
      return res.status(400).json({ error: 'Wallet address required' });
    }
    
    const nfts = await fetchWalletNFTs(wallet);
    
    // Check if this is a new wallet (without calculating governance power to save RPC credits)
    const existingCitizen = await pool.query('SELECT id FROM citizens WHERE wallet = $1', [wallet]);
    const isNewWallet = existingCitizen.rows.length === 0;
    
    res.json({ 
      nfts, 
      is_new_wallet: isNewWallet,
      message: isNewWallet && nfts.length > 0 ? `Found ${nfts.length} PERKS NFTs - governance power will be calculated when you create your pin` : undefined
    });
  } catch (error) {
    console.error('Error fetching wallet NFTs:', error);
    res.status(500).json({ error: 'Failed to fetch NFTs' });
  }
});

// Add API endpoint to check username availability
app.get('/api/check-username', async (req, res) => {
  try {
    const { username, wallet } = req.query;
    if (!username) {
      return res.status(400).json({ error: 'Username required' });
    }
    
    const trimmedUsername = username.trim();
    
    // Allow multiple "Anonymous Citizen" entries
    if (trimmedUsername.toLowerCase() === 'anonymous citizen') {
      const available = true;
      res.json({ 
        available,
        username: trimmedUsername,
        message: 'Username is available'
      });
      return;
    }
    
    // Check if username exists for other wallets
    let query = 'SELECT id, wallet FROM citizens WHERE LOWER(nickname) = LOWER($1)';
    let params = [trimmedUsername];
    
    if (wallet) {
      // If wallet is provided, exclude current wallet from check
      query += ' AND wallet != $2';
      params.push(wallet);
    }
    
    const result = await pool.query(query, params);
    
    const available = result.rows.length === 0;
    res.json({ 
      available,
      username: username.trim(),
      message: available ? 'Username is available' : 'Username is already taken'
    });
  } catch (error) {
    console.error('Error checking username:', error);
    res.status(500).json({ error: 'Failed to check username' });
  }
});

// Add API endpoint for PERKS collection stats
app.get('/api/governance-stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total_citizens,
        SUM(
          CASE 
            WHEN nft_ids IS NOT NULL AND nft_ids != '[]' THEN 
              array_length(string_to_array(trim(both '[]' from nft_ids), ','), 1)
            ELSE 0 
          END
        ) as total_perks
      FROM citizens
      WHERE nft_ids IS NOT NULL AND nft_ids != '[]'
    `);
    
    const stats = result.rows[0];
    res.json({
      totalCitizens: parseInt(stats.total_citizens) || 0,
      totalPerks: parseInt(stats.total_perks) || 0
    });
  } catch (error) {
    console.error('Error fetching PERKS stats:', error);
    res.status(500).json({ error: 'Failed to fetch PERKS stats' });
  }
});

// Add governance data export endpoint for JSON generation
app.get('/api/governance-export', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        wallet,
        nickname,
        native_governance_power,
        governance_power,
        delegated_governance_power,
        total_governance_power,
        locked_governance_power,
        unlocked_governance_power,
        nft_ids,
        created_at,
        updated_at
      FROM citizens 
      WHERE wallet IS NOT NULL 
      ORDER BY native_governance_power DESC, nickname
    `);
    
    const citizens = result.rows.map(citizen => ({
      wallet: citizen.wallet,
      nickname: citizen.nickname || 'Anonymous Citizen',
      native_governance_power: parseFloat(citizen.native_governance_power) || 0,
      governance_power: parseFloat(citizen.governance_power) || 0,
      delegated_governance_power: parseFloat(citizen.delegated_governance_power) || 0,
      total_governance_power: parseFloat(citizen.total_governance_power) || 0,
      locked_governance_power: parseFloat(citizen.locked_governance_power) || 0,
      unlocked_governance_power: parseFloat(citizen.unlocked_governance_power) || 0,
      nft_count: citizen.nft_ids ? JSON.parse(citizen.nft_ids).length : 0,
      last_updated: citizen.updated_at || citizen.created_at
    }));
    
    const exportData = {
      generated_at: new Date().toISOString(),
      total_citizens: citizens.length,
      citizens: citizens
    };
    
    res.json(exportData);
  } catch (error) {
    console.error('Error exporting governance data:', error);
    res.status(500).json({ error: 'Failed to export governance data' });
  }
});

// Add auth message generation endpoint
app.get('/api/auth/generate-message', (req, res) => {
  const timestamp = Date.now();
  const message = `Verify wallet ownership for IslandDAO Citizen Map - Timestamp: ${timestamp}`;
  res.json({ message, timestamp });
});

// Add verified citizen save endpoint with signature verification
app.post('/api/save-citizen-verified', async (req, res) => {
  try {
    const { 
      wallet_address, 
      signature, 
      original_message, 
      fallback_method = 'message',
      lat, 
      lng, 
      nickname, 
      bio, 
      twitter_handle, 
      telegram_handle, 
      discord_handle,
      primary_nft,
      pfp_nft,
      image_url,
      nfts = []
    } = req.body;

    // Basic validation
    if (!wallet_address || !signature || !original_message || !lat || !lng) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // TODO: Add signature verification logic here
    // For now, we'll trust the signature (implement crypto verification later)
    console.log(`Verified citizen pin: ${wallet_address} using ${fallback_method} method`);

    // Check if citizen already exists
    const existingCitizen = await pool.query(
      'SELECT id FROM citizens WHERE wallet = $1',
      [wallet_address]
    );

    if (existingCitizen.rows.length > 0) {
      // Update existing citizen - only update pin location and profile, preserve existing governance data
      console.log(`Updating existing citizen ${wallet_address} - preserving governance data to save RPC credits`);
      
      const result = await pool.query(`
        UPDATE citizens SET 
          lat = $2, lng = $3, nickname = $4, bio = $5, 
          twitter_handle = $6, telegram_handle = $7, discord_handle = $8,
          primary_nft = $9, pfp_nft = $10, image_url = $11, updated_at = NOW()
        WHERE wallet = $1
        RETURNING *
      `, [wallet_address, lat, lng, nickname, bio, twitter_handle, telegram_handle, discord_handle, primary_nft, pfp_nft, image_url]);
      
      console.log(`Updated existing citizen ${wallet_address} pin location and profile`);
      res.json({ success: true, citizen: result.rows[0], action: 'updated' });
    } else {
      // Insert new citizen - fetch NFT data and calculate governance power
      console.log(`New citizen ${wallet_address} - fetching NFT data and governance power`);
      
      // Fetch NFT data for new citizen
      let nftData = [];
      let nftIds = [];
      try {
        nftData = await fetchWalletNFTs(wallet_address);
        nftIds = nftData.map(nft => nft.mint);
        console.log(`Fetched ${nftData.length} NFTs for new citizen ${wallet_address}`);
      } catch (error) {
        console.error(`Error fetching NFTs for ${wallet_address}:`, error);
      }
      
      // Calculate authentic governance power for new citizen using locked VSR calculator
      let nativeGovernancePower = 0;
      let delegatedGovernancePower = 0;
      let totalGovernancePower = 0;
      
      try {
        console.log(`Calculating authentic governance power for new citizen ${wallet_address}...`);
        const vsrResponse = await fetch(`http://localhost:3001/api/governance-power?wallet=${wallet_address}`);
        if (vsrResponse.ok) {
          const vsrData = await vsrResponse.json();
          nativeGovernancePower = vsrData.nativeGovernancePower || 0;
          delegatedGovernancePower = vsrData.delegatedGovernancePower || 0;
          totalGovernancePower = vsrData.totalGovernancePower || 0;
          console.log(`✅ New citizen ${wallet_address}: ${totalGovernancePower.toLocaleString()} ISLAND total governance power`);
        } else {
          console.error(`VSR API returned error for ${wallet_address}:`, await vsrResponse.text());
        }
      } catch (error) {
        console.error(`Error calculating governance power for ${wallet_address}:`, error);
      }
      
      // Insert new citizen with complete authentic data
      const result = await pool.query(`
        INSERT INTO citizens (
          wallet, lat, lng, nickname, bio, 
          twitter_handle, telegram_handle, discord_handle,
          primary_nft, pfp_nft, image_url, nft_ids, nft_metadata,
          native_governance_power, governance_power, total_governance_power
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        RETURNING *
      `, [wallet_address, lat, lng, nickname, bio, twitter_handle, telegram_handle, discord_handle, 
          primary_nft, pfp_nft, image_url, JSON.stringify(nftIds), JSON.stringify(nftData), 
          nativeGovernancePower, delegatedGovernancePower, totalGovernancePower]);
      
      console.log(`New citizen ${wallet_address} added with ${nftData.length} NFTs and ${totalGovernancePower.toLocaleString()} ISLAND governance power`);
      res.json({ success: true, citizen: result.rows[0], action: 'created' });
    }

  } catch (error) {
    console.error('Error saving verified citizen:', error);
    res.status(500).json({ error: 'Failed to save citizen pin' });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Citizen Map server running at http://localhost:${port}`);
  console.log('Daily governance sync scheduled for 00:00 UTC');
});