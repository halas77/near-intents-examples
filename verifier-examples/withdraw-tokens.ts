/**
 *  Withdraw Tokens (Single & Batch Support)
 *
 *  Moves tokens out of your intents account to external wallet addresses on any supported chain.
 *  Multiple tokens can be withdrawn in ONE SINGLE intent transaction on NEAR.
 *  The withdrawal is settled on-chain via the bridge, so bridge fees apply.
 *
 *  Why withdrawals?
 *  ----------------
 *  Tokens inside the intents system are held by the `intents.near` smart contract.
 *  To use them on an external chain (e.g. spend USDC on Arbitrum, send BTC to cold storage),
 *  you need to withdraw — the bridge releases the real tokens on the destination chain.
 *
 *  Two-phase flow:
 *   1. Fee estimation — calls `estimateWithdrawalFee` for all configured tokens to see expected bridge fees
 *      before committing. Set `withdrawalQuoteOnly = true` to stop here.
 *   2. Submission — signs all token withdrawals in a SINGLE intent and submits it to the relayer.
 *      The SDK handles signing, broadcasting, and polling for completion across destination chains.
 *
 *  Fee modes:
 *   - `feeInclusive: true`  — fee is deducted from the withdrawal amount (you receive amount - fee)
 *   - `feeInclusive: false` — fee is added on top (you need extra balance to cover it)
 *
 *  Configure the variables below:
 *   - `withdrawals[]`      — list of tokens to withdraw in a single intent
 *   - `tokenId`            — token asset ID for each withdrawal entry
 *   - `amount`             — human-readable amount for each entry
 *   - `destinationAddress` — external wallet address for each entry
 *   - `destinationMemo`    — optional memo per entry (required for some chains like Stellar, XRP)
 *   - `feeInclusive`       — optional per-entry fee mode (defaults to true)
 *   - `withdrawalQuoteOnly` — set to true to only see fee quotes without executing
 *
 *  Run:  pnpm sdk/withdraw-tokens
 *
 */

import {
  FeeEstimation,
  IIntentSigner,
  WithdrawalParams,
} from '@defuse-protocol/intents-sdk';
import { fileURLToPath } from 'node:url';
import { formatUnits, parseUnits, stringify } from 'viem';
import { getTokenBalances } from './get-balances';
import { getTokenById, Token } from './get-tokens-list';
import { intentsSdk } from './utils/config';
import { getSigner } from './utils/signer';

export type WithdrawalConfig = {
  tokenId: string;
  amount: string;
  destinationAddress: string;
  destinationMemo?: string;
  feeInclusive?: boolean;
};

type ResolvedWithdrawal = {
  config: WithdrawalConfig;
  token: Token;
  amountIn: string;
};

/**
 * Estimate the bridge fees for one or multiple withdrawals without executing them.
 */
export const getWithdrawalQuote = async ({
  withdrawalParams,
}: {
  withdrawalParams: WithdrawalParams[];
}) => {
  return intentsSdk.estimateWithdrawalFee({
    withdrawalParams,
  });
};

/**
 * Sign and submit all configured withdrawals in a SINGLE intent, then wait for settlement.
 * All tokens are bundled into 1 intent hash and settled atomically on NEAR.
 */
export const submitWithdrawal = async ({
  withdrawalParams,
  feeEstimation,
  signer,
}: {
  withdrawalParams: WithdrawalParams[];
  feeEstimation: FeeEstimation[];
  signer: IIntentSigner;
}) => {
  // Attach your wallet signer to the SDK instance
  intentsSdk.setIntentSigner(signer);

  console.log(
    `Submitting 1 single intent for ${withdrawalParams.length} token withdrawal(s)...`,
  );

  // Submit all withdrawal items together in ONE single intent
  const { intentHash } = await intentsSdk.signAndSendWithdrawalIntent({
    withdrawalParams,
    feeEstimation,
  });
  console.log(`Intent submitted: ${intentHash}`);

  // Wait for Near-side settlement first (atomic execution of all withdrawals on NEAR)
  console.log('Waiting for intent settlement on NEAR...');
  const intentTx = await intentsSdk.waitForIntentSettlement({
    intentHash,
  });
  console.log(`NEAR intent settled! Tx: ${intentTx.hash}`);

  // Destination indexing can lag even when funds already arrived.
  // Cap the wait so the script returns promptly with useful hashes.
  let destinationTx: Array<{ hash: string | null }> | null = null;
  try {
    console.log('Waiting for withdrawal completion on destination chain(s)...');
    destinationTx = await intentsSdk.waitForWithdrawalCompletion({
      withdrawalParams,
      intentTx,
      signal: AbortSignal.timeout(destinationWaitTimeoutMs),
    });
  } catch (error) {
    console.warn(
      `Destination completion wait timed out after ${destinationWaitTimeoutMs}ms. ` +
        'The withdrawal may still be completed on destination chain.',
    );
    console.warn(error);
  }

  return {
    intentHash,
    intentTx,
    destinationTx,
  };
};

// ── Configuration ──────────────────────────────────────────────────────────────

// Configure multiple withdrawals to execute in ONE single intent submission.
// Add 2, 3, or more tokens here — they will all be bundled into the same intent.
const withdrawals: WithdrawalConfig[] = [
  {
    tokenId: 'nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L', // USDC
    amount: '0.01',
    destinationAddress: '0x70E93a63A6f2a85784bF71Ba1d3Ca745202f9B33',
    feeInclusive: true,
  },
  {
    tokenId: 'nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr', // USDT
    amount: '0.01',
    destinationAddress: '0x70E93a63A6f2a85784bF71Ba1d3Ca745202f9B33',
    feeInclusive: true,
  },
  // Example for a 3rd token:
  // {
  //   tokenId: 'nep245:v2_1.omni.hot.tg:56_12zbnsg6xndDVj25QyL82YMPudb', // ASTER
  //   amount: '1.0',
  //   destinationAddress: '0x70E93a63A6f2a85784bF71Ba1d3Ca745202f9B33',
  //   feeInclusive: true,
  // },
];

const withdrawalQuoteOnly = false; // Set to true to only see fee quotes without executing
const destinationWaitTimeoutMs = 120_000; // Limit destination wait to 2 minutes

const resolveWithdrawals = async (
  configs: WithdrawalConfig[],
): Promise<ResolvedWithdrawal[]> => {
  const resolved = await Promise.all(
    configs.map(async (entry, index) => {
      const token = await getTokenById({ intents_token_id: entry.tokenId });
      if (!token) {
        throw new Error(`Token not found for entry ${index}: ${entry.tokenId}`);
      }

      const amountIn = parseUnits(entry.amount, token.decimals).toString();
      return {
        config: entry,
        token,
        amountIn,
      };
    }),
  );

  return resolved;
};

async function main() {
  // Auto-detect signer type (NEAR or EVM) based on which .env key is set
  const { signer, authIdentifier, authMethod } = await getSigner();
  if (!signer) {
    throw new Error('Signer not found');
  }

  if (withdrawals.length === 0) {
    throw new Error('No withdrawals configured');
  }

  const resolvedWithdrawals = await resolveWithdrawals(withdrawals);

  // Preflight: verify configured amounts do not exceed current intents balances.
  const balances = await getTokenBalances({ authIdentifier, authMethod });
  const balanceByAssetId = balances.reduce(
    (acc, token) => {
      acc[token.assetId] = BigInt(token.balance);
      return acc;
    },
    {} as Record<string, bigint>,
  );

  const insufficientBalances = resolvedWithdrawals
    .map((entry) => {
      const requested = BigInt(entry.amountIn);
      const available = balanceByAssetId[entry.token.assetId] ?? 0n;
      if (requested <= available) {
        return null;
      }

      return {
        symbol: entry.token.symbol,
        assetId: entry.token.assetId,
        requested,
        available,
        requestedHuman: entry.config.amount,
        availableHuman: formatUnits(available, entry.token.decimals),
      };
    })
    .filter((x) => x !== null);

  if (insufficientBalances.length > 0) {
    throw new Error(
      [
        'Insufficient balance for one or more configured withdrawals:',
        ...insufficientBalances.map(
          (entry) =>
            `- ${entry.symbol} (${entry.assetId}): requested=${entry.requestedHuman} (${entry.requested.toString()}), available=${entry.availableHuman} (${entry.available.toString()})`,
        ),
      ].join('\n'),
    );
  }

  console.log(
    `Preparing batch withdrawal (${resolvedWithdrawals.length} token(s) in 1 intent)...`,
  );
  console.table(
    resolvedWithdrawals.map((entry) => ({
      token: entry.token.symbol,
      assetId: entry.token.assetId,
      amountHuman: entry.config.amount,
      amountSmallestUnit: entry.amountIn,
      destination: entry.config.destinationAddress,
      memo: entry.config.destinationMemo ?? '',
      feeInclusive: entry.config.feeInclusive ?? true,
    })),
  );

  const withdrawalParams: WithdrawalParams[] = resolvedWithdrawals.map(
    (entry) => ({
      assetId: entry.token.assetId,
      amount: BigInt(entry.amountIn),
      destinationAddress: entry.config.destinationAddress,
      feeInclusive: entry.config.feeInclusive ?? true,
      destinationMemo: entry.config.destinationMemo,
    }),
  );

  // Phase 1: Get fee estimations for all configured withdrawals
  const feeEstimation = await intentsSdk.estimateWithdrawalFee({
    withdrawalParams,
  });

  const invalidFeeInclusiveRows = resolvedWithdrawals
    .map((entry, index) => {
      const isInclusive = entry.config.feeInclusive ?? true;
      if (!isInclusive) return null;

      const amount = BigInt(entry.amountIn);
      const fee = feeEstimation[index].amount;
      const net = amount - fee;
      if (net > 0n) {
        return null;
      }

      return {
        symbol: entry.token.symbol,
        assetId: entry.token.assetId,
        amount,
        fee,
      };
    })
    .filter((x) => x !== null);

  if (invalidFeeInclusiveRows.length > 0) {
    throw new Error(
      [
        'One or more withdrawals are too small after fee deduction (feeInclusive=true):',
        ...invalidFeeInclusiveRows.map(
          (entry) =>
            `- ${entry.symbol} (${entry.assetId}): amount=${entry.amount.toString()}, fee=${entry.fee.toString()}`,
        ),
      ].join('\n'),
    );
  }

  // If quote-only mode, display the fee and exit
  if (withdrawalQuoteOnly) {
    console.log('\nBatch withdrawal fee quote:');
    console.log(stringify(feeEstimation, null, 2));
    return;
  }

  // Phase 2: Execute all withdrawals in ONE single intent
  console.log('\nSubmitting all withdrawals in a single intent...');
  const withdrawalResult = await submitWithdrawal({
    withdrawalParams,
    feeEstimation,
    signer,
  });

  console.log('\nBatch withdrawal submitted. Settlement result:');
  console.log(JSON.stringify(withdrawalResult, null, 2));
}

// Only run when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
