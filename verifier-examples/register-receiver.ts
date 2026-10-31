/**
 *  Register Receiver on Multi-Token Contract
 *
 *  Calls `storage_deposit` on the MT contract (v2_1.omni.hot.tg) to register
 *  the receiver account so it can hold tokens. This must be done BEFORE
 *  mt_batch_transfer_call, otherwise the MT contract panics with
 *  "<account> is not an existing account".
 *
 *  Run:  pnpm sdk/register-receiver
 */

import 'dotenv/config';
import { getNearWalletFromKeyPair } from './utils/near-config';

async function main() {
  const privateKey = process.env.INTENTS_SDK_PRIVATE_KEY_NEAR;
  if (!privateKey) {
    throw new Error('INTENTS_SDK_PRIVATE_KEY_NEAR is not set in .env');
  }

  const mtContract = process.env.MT_CONTRACT || 'v2_1.omni.hot.tg';
  const receiverId = process.env.MT_RECEIVER_ID;
  if (!receiverId) {
    throw new Error('MT_RECEIVER_ID is not set in .env');
  }

  console.log(`Registering "${receiverId}" on "${mtContract}"...`);
  console.log();

  const { account, accountId } = await getNearWalletFromKeyPair(privateKey);
  console.log(`Signer account: ${accountId}`);

  // Call storage_deposit on the multi-token contract
  // Deposit 0.25 NEAR (generous — typical registration needs ~0.00125 NEAR)
  const depositAmount = process.env.MT_STORAGE_DEPOSIT || '250000000000000000000000'; // 0.25 NEAR

  console.log(`Calling storage_deposit on ${mtContract}...`);
  console.log(`  account_id: ${receiverId}`);
  console.log(`  deposit:    ${depositAmount} yoctoNEAR`);
  console.log();

  try {
    const result = await account.callFunction({
      contractId: mtContract,
      methodName: 'storage_deposit',
      args: {
        account_id: receiverId,
      },
      gas: 30_000_000_000_000n, // 30 TGas
      deposit: BigInt(depositAmount),
    });

    console.log(`✅ Storage deposit successful!`);
    console.log(`   "${receiverId}" is now registered on "${mtContract}"`);
    console.log(`   Result:`, JSON.stringify(result, null, 2));
  } catch (error: unknown) {
    // If already registered, storage_deposit usually succeeds and refunds excess.
    // But some contracts may error — handle gracefully.
    console.error('❌ storage_deposit failed:', error);
    console.log();
    console.log('The account may already be registered, or the contract');
    console.log('may use a different registration method.');
    console.log();
    console.log('Alternative: try registering via NEAR CLI:');
    console.log(
      `  near call ${mtContract} storage_deposit '{"account_id":"${receiverId}"}' --accountId ${accountId} --deposit 0.25`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

