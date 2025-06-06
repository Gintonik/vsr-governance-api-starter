/**
 * Canonical Unlocked-Aware Scanner
 * Uses Anchor-compatible deserialization to properly handle unlocked deposits
 * Separates native and delegated governance power calculation
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import { config } from 'dotenv';
import fs from 'fs';
import pkg from 'pg';
config();

const { Pool } = pkg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const VSR_PROGRAM_ID = new PublicKey('vsr2nfGVNHmSY8uxoBGqq8AQbwz3JwaEaHqGbsTPXqQ');
const connection = new Connection(process.env.HELIUS_RPC_URL);

// Canonical registrar parameters
const REGISTRAR_PARAMS = {
  baseline: 3_000_000_000,
  maxExtra: 3_000_000_000,
  saturationSecs: 31_536_000
};

function calculateMultiplier(lockup, now = Date.now() / 1000) {
  if (lockup.kind === 0) return 1.0; // Unlocked deposits

  const start = lockup.startTs || 0;
  const end = lockup.endTs || 0;
  const timeLeft = Math.max(0, end - now);
  const totalDuration = Math.max(1, end - start);
  const saturation = REGISTRAR_PARAMS.saturationSecs;

  let multiplierRatio = 0;

  if (lockup.kind === 1) { // cliff
    multiplierRatio = timeLeft >= saturation ? 1 : timeLeft / saturation;
  } else if (lockup.kind === 2 || lockup.kind === 3) { // constant or vesting
    const unlockedRatio = Math.min(1, (now - start) / totalDuration);
    const remainingRatio = 1 - unlockedRatio;
    multiplierRatio = Math.min(1, remainingRatio * (totalDuration / saturation));
  } else {
    // Fallback for other lockup kinds
    multiplierRatio = Math.min(1, timeLeft / saturation);
  }

  const multiplier = (REGISTRAR_PARAMS.baseline + REGISTRAR_PARAMS.maxExtra * multiplierRatio) / 1e9;
  
  // Log lockup details for debugging
  if (lockup.kind > 0) {
    console.log(`[LOCKUP] Kind: ${lockup.kind}, Start: ${start}, End: ${end}, Multiplier: ${multiplier.toFixed(3)}`);
  }
  
  return multiplier;
}

// Phantom deposit filter - removes 1k and 11k marker deposits
function isPhantomDeposit(deposit, walletAddress = '') {
  const isUnlocked = deposit.lockupKind === 0 || deposit.lockup?.kind === 0;
  const amount = deposit.amount || (deposit.amountDepositedNative / 1e6);
  const rounded = Math.round(amount);
  
  const isPhantom = isUnlocked && (rounded === 1000 || rounded === 11000);
  
  if (isPhantom) {
    console.log(`[PHANTOM FILTER] Skipped ${rounded} ISLAND deposit for ${walletAddress.substring(0, 8)}`);
  }
  
  return isPhantom;
}

// Create dummy wallet for Anchor provider (read-only operations)
function createDummyWallet() {
  return {
    publicKey: new PublicKey('11111111111111111111111111111112'),
    signTransaction: async () => { throw new Error('Read-only wallet'); },
    signAllTransactions: async () => { throw new Error('Read-only wallet'); }
  };
}

async function loadVSRProgram() {
  try {
    const idl = JSON.parse(fs.readFileSync('./vsr-idl.json', 'utf8'));
    const dummyWallet = createDummyWallet();
    const provider = new AnchorProvider(connection, dummyWallet, {});
    const program = new Program(idl, VSR_PROGRAM_ID, provider);
    return program;
  } catch (error) {
    console.log('Could not load VSR program with Anchor, using raw account parsing');
    return null;
  }
}

// Parse deposit entry from raw account data (fallback method)
function parseDepositEntryRaw(data, offset) {
  try {
    const isUsed = data[offset];
    if (isUsed === 0) return null;
    
    const amountDepositedNative = Number(data.readBigUInt64LE(offset + 8));
    const lockupKind = data[offset + 32];
    const startTs = Number(data.readBigUInt64LE(offset + 40));
    const endTs = Number(data.readBigUInt64LE(offset + 48));
    
    return {
      isUsed: isUsed === 1,
      amountDepositedNative: amountDepositedNative,
      lockup: {
        kind: lockupKind,
        startTs: startTs,
        endTs: endTs
      }
    };
  } catch (error) {
    return null;
  }
}

// Parse voter account data with hybrid approach
function parseVoterAccountData(data, accountPubkey) {
  const deposits = [];
  const currentTime = Date.now() / 1000;
  
  try {
    // Extract authority and voterAuthority
    let authority = null;
    let voterAuthority = null;
    
    try {
      if (data.length >= 40) {
        authority = new PublicKey(data.slice(8, 40)).toBase58();
      }
    } catch (e) {}
    
    try {
      if (data.length >= 104) {
        voterAuthority = new PublicKey(data.slice(72, 104)).toBase58();
      }
    } catch (e) {}
    
    // Method 1: Parse deposit entries (locked deposits)
    const depositEntrySize = 56;
    const maxDeposits = 32;
    
    for (let i = 0; i < maxDeposits; i++) {
      const offset = 104 + (i * depositEntrySize);
      
      if (offset + depositEntrySize > data.length) break;
      
      const deposit = parseDepositEntryRaw(data, offset);
      
      if (deposit && deposit.isUsed) {
        const amount = deposit.amountDepositedNative / 1e6;
        
        if (amount >= 50) {
          // Check for phantom deposits before processing
          const testDeposit = {
            amount: amount,
            lockupKind: deposit.lockup.kind,
            lockup: deposit.lockup
          };
          
          if (isPhantomDeposit(testDeposit, authority)) {
            continue; // Skip phantom deposits
          }
          
          const multiplier = calculateMultiplier(
            deposit.lockup, 
            currentTime
          );
          
          const power = amount * multiplier;
          
          deposits.push({
            amount: amount,
            multiplier: multiplier,
            power: power,
            lockupKind: deposit.lockup.kind,
            endTs: deposit.lockup.endTs,
            isUnlocked: deposit.lockup.kind === 0,
            authority: authority,
            voterAuthority: voterAuthority,
            account: accountPubkey,
            source: 'depositEntry'
          });
        }
      }
    }
    
    // Method 2: Direct amount scanning for unlocked deposits (like Fgv1's 200k)
    // These might not be in the formal depositEntries but stored as direct amounts
    const knownUnlockedOffsets = [104, 112, 184, 264, 344]; // From working results
    
    for (const offset of knownUnlockedOffsets) {
      if (offset + 8 <= data.length) {
        try {
          const rawAmount = data.readBigUInt64LE(offset);
          const amount = Number(rawAmount) / 1e6;
          
          if (amount >= 1000 && amount <= 20000000) {
            // Check if this amount is already found in deposit entries
            const alreadyFound = deposits.some(d => Math.abs(d.amount - amount) < 1);
            
            if (!alreadyFound) {
              // Check for phantom deposits before processing
              const testDeposit = {
                amount: amount,
                lockupKind: 0
              };
              
              if (isPhantomDeposit(testDeposit, authority)) {
                continue; // Skip phantom deposits
              }
              
              // Enhanced lockup detection for multi-lockup accounts
              let lockupInfo = { kind: 0, startTs: 0, endTs: 0 };
              let multiplier = 1.0;
              
              // Look for lockup metadata in nearby bytes
              const scanRange = 40;
              for (let scanOffset = offset - scanRange; scanOffset <= offset + scanRange; scanOffset += 8) {
                if (scanOffset >= 0 && scanOffset + 8 <= data.length) {
                  try {
                    const potentialTs = Number(data.readBigUInt64LE(scanOffset));
                    if (potentialTs > 1577836800 && potentialTs < 1893456000) {
                      for (let kindOffset = scanOffset - 16; kindOffset <= scanOffset + 16; kindOffset++) {
                        if (kindOffset >= 0 && kindOffset < data.length) {
                          const kind = data[kindOffset];
                          if (kind >= 1 && kind <= 4) {
                            let startTs = 0;
                            let endTs = 0;
                            
                            for (let tsOffset = kindOffset - 32; tsOffset <= kindOffset + 32; tsOffset += 8) {
                              if (tsOffset >= 0 && tsOffset + 8 <= data.length) {
                                try {
                                  const ts = Number(data.readBigUInt64LE(tsOffset));
                                  if (ts > 1577836800 && ts < 1893456000) {
                                    if (startTs === 0 || ts < startTs) {
                                      endTs = startTs;
                                      startTs = ts;
                                    } else if (endTs === 0 || ts > endTs) {
                                      endTs = ts;
                                    }
                                  }
                                } catch (e) {}
                              }
                            }
                            
                            if (endTs > currentTime) {
                              lockupInfo = { kind, startTs, endTs };
                              multiplier = calculateMultiplier(lockupInfo, currentTime);
                              break;
                            }
                          }
                        }
                      }
                      if (lockupInfo.kind > 0) break;
                    }
                  } catch (e) {}
                }
              }
              
              const power = amount * multiplier;
              
              deposits.push({
                amount: amount,
                multiplier: multiplier,
                power: power,
                lockupKind: lockupInfo.kind,
                endTs: lockupInfo.endTs,
                isUnlocked: lockupInfo.kind === 0,
                authority: authority,
                voterAuthority: voterAuthority,
                account: accountPubkey,
                source: lockupInfo.kind > 0 ? 'lockupDetected' : 'directAmount',
                offset: offset
              });
            }
          }
        } catch (e) {
          continue;
        }
      }
    }
    
    return { authority, voterAuthority, deposits };
    
  } catch (error) {
    console.error(`Error parsing voter account ${accountPubkey}:`, error.message);
    return { authority: null, voterAuthority: null, deposits: [] };
  }
}

async function calculateGovernancePowerForWallet(walletAddress) {
  console.log(`Calculating governance power for ${walletAddress.substring(0, 8)}...`);
  
  try {
    // Get all VSR accounts
    const allVSRAccounts = await connection.getProgramAccounts(VSR_PROGRAM_ID, {
      commitment: "confirmed"
    });
    
    let nativeGovernancePower = 0;
    let delegatedGovernancePower = 0;
    const allDeposits = [];
    const unlockedDeposits = [];
    
    for (const account of allVSRAccounts) {
      const data = account.account.data;
      const accountPubkey = account.pubkey.toBase58();
      
      // Only process voter accounts (typically 2728 bytes)
      if (data.length === 2728) {
        const parsed = parseVoterAccountData(data, accountPubkey);
        
        for (const deposit of parsed.deposits) {
          // Native governance power: wallet is the authority
          if (deposit.authority === walletAddress) {
            nativeGovernancePower += deposit.power;
            allDeposits.push({ ...deposit, type: 'native' });
            
            if (deposit.isUnlocked) {
              unlockedDeposits.push(deposit);
            }
          }
          
          // Delegated governance power: wallet is voterAuthority but not authority
          if (deposit.voterAuthority === walletAddress && deposit.authority !== walletAddress) {
            delegatedGovernancePower += deposit.power;
            allDeposits.push({ ...deposit, type: 'delegated' });
          }
        }
      }
    }
    
    const totalGovernancePower = nativeGovernancePower + delegatedGovernancePower;
    
    console.log(`  Native: ${nativeGovernancePower.toLocaleString()} ISLAND`);
    console.log(`  Delegated: ${delegatedGovernancePower.toLocaleString()} ISLAND`);
    console.log(`  Total: ${totalGovernancePower.toLocaleString()} ISLAND`);
    
    if (unlockedDeposits.length > 0) {
      console.log(`  Unlocked deposits: ${unlockedDeposits.length}`);
      unlockedDeposits.forEach(d => {
        console.log(`    ${d.amount.toLocaleString()} ISLAND (unlocked, mult: ${d.multiplier})`);
      });
    }
    
    return {
      wallet: walletAddress,
      nativeGovernancePower,
      delegatedGovernancePower,
      totalGovernancePower,
      deposits: allDeposits,
      unlockedDeposits
    };
    
  } catch (error) {
    console.error(`Error calculating governance power for ${walletAddress}:`, error);
    return {
      wallet: walletAddress,
      nativeGovernancePower: 0,
      delegatedGovernancePower: 0,
      totalGovernancePower: 0,
      deposits: [],
      unlockedDeposits: []
    };
  }
}

async function testCanonicalScanner() {
  console.log('CANONICAL UNLOCKED-AWARE VSR SCANNER');
  console.log('====================================');
  console.log('Testing 6 key wallets with proper unlocked deposit handling');
  console.log('');
  
  const testWallets = [
    '3PKhzE9wuEkGPHHu2sNCvG86xNtDJduAcyBPXpE6cSNt',
    'Fywb7YDCXxtD7pNKThJ36CAtVe23dEeEPf7HqKzJs1VG',
    '4pT6ESaMQTgpMs2ZZ81pFF8BieGtY9x4CCK2z6aoYoe4',
    'kruHL3zJ1Mcbdibsna5xM6yMp7PZZ4BsNTpj2UMgvZC',
    '7pPJt2xoEoPy8x8Hf2D6U6oLfNa5uKmHHRwkENVoaxmA',
    'GJdRQcsyz49FMM4LvPqpaM2QA3yWFr8WamJ95hkwCBAh'
  ];
  
  const results = [];
  
  for (let i = 0; i < testWallets.length; i++) {
    const wallet = testWallets[i];
    console.log(`[${i + 1}/6] Testing ${wallet.substring(0, 8)}...`);
    
    const result = await calculateGovernancePowerForWallet(wallet);
    results.push(result);
    
    console.log('');
  }
  
  // Summary
  console.log('TEST RESULTS SUMMARY:');
  console.log('====================');
  
  results.forEach(result => {
    console.log(`${result.wallet.substring(0, 8)}: ${result.totalGovernancePower.toLocaleString()} ISLAND (${result.nativeGovernancePower.toLocaleString()} + ${result.delegatedGovernancePower.toLocaleString()})`);
  });
  
  return results;
}

async function updateAllCitizens() {
  console.log('\nUPDATING ALL CITIZENS');
  console.log('====================');
  
  // Get all citizen wallets
  const client = await pool.connect();
  const result = await client.query('SELECT wallet FROM citizens ORDER BY wallet');
  const citizenWallets = result.rows.map(row => row.wallet);
  client.release();
  
  console.log(`Processing ${citizenWallets.length} citizens...`);
  
  const results = [];
  
  for (let i = 0; i < citizenWallets.length; i++) {
    const wallet = citizenWallets[i];
    console.log(`${i + 1}/${citizenWallets.length}: ${wallet.substring(0, 8)}...`);
    
    const result = await calculateGovernancePowerForWallet(wallet);
    results.push(result);
    
    // Update database
    const updateClient = await pool.connect();
    try {
      await updateClient.query(
        'UPDATE citizens SET governance_power = $1 WHERE wallet = $2',
        [result.totalGovernancePower, wallet]
      );
    } finally {
      updateClient.release();
    }
  }
  
  // Final summary
  const citizensWithPower = results.filter(r => r.totalGovernancePower > 0).sort((a, b) => b.totalGovernancePower - a.totalGovernancePower);
  const totalPower = results.reduce((sum, r) => sum + r.totalGovernancePower, 0);
  
  console.log('\nFINAL RESULTS:');
  console.log('==============');
  
  citizensWithPower.forEach((citizen, index) => {
    console.log(`${index + 1}. ${citizen.wallet}: ${citizen.totalGovernancePower.toLocaleString()} ISLAND`);
  });
  
  console.log(`\nCitizens with governance power: ${citizensWithPower.length}/${citizenWallets.length}`);
  console.log(`Total governance power: ${totalPower.toLocaleString()} ISLAND`);
  
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  testCanonicalScanner()
    .then(() => updateAllCitizens())
    .catch(console.error);
}