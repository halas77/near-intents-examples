/**
 *  Withdraw Tokens
 *
 *  Moves tokens out of your intents account to an external wallet address on any supported chain.
 *  The withdrawal is settled on-chain via the POA bridge, so a bridge fee applies.
 *
 *  Why withdrawals?
 *  ----------------
 *  Tokens inside the intents system are held by the `intents.near` smart contract.
 *  To use them on an external chain (e.g. spend USDC on Arbitrum, send BTC to cold storage),
 *  you need to withdraw — the bridge releases the real tokens on the destination chain.
 *
 *  Two-phase flow:
 *   1. Fee estimation — call `estimateWithdrawalFee` to see the expected bridge fee
 *      before committing. Set `withdrawalQuoteOnly = true` to stop here.
 *   2. Submission — sign the intent, submit it, and wait for on-chain settlement.
 *      The SDK handles signing, broadcasting, and polling for completion.
 *
 *  Fee modes:
 *   - `feeInclusive: true`  — fee is deducted from the withdrawal amount (you receive less)
 *   - `feeInclusive: false` — fee is added on top (you need extra balance to cover it)
 *
 *  Configure the variables below:
 *   - `withdrawals[]`      — list of tokens to withdraw in a single batch
 *   - `tokenId`            — token asset ID for each withdrawal entry
 *   - `amount`             — human-readable amount for each entry
 *   - `destinationAddress` — external wallet address for each entry
 *   - `destinationMemo`    — optional memo per entry (required for some chains like Stellar, XRP)
 *   - `withdrawalQuoteOnly` — set to true to only see the fee quote without executing
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

type WithdrawalConfig = {
  tokenId: string;
  amount: string;
  destinationAddress: string;
  destinationMemo?: string;
};

type ResolvedWithdrawal = {
  config: WithdrawalConfig;
  token: Token;
  amountIn: string;
};

type WithdrawalBatch = {
  withdrawalParams: WithdrawalParams[];
  feeEstimation: FeeEstimation[];
  entries: ResolvedWithdrawal[];
};

/**
 * Sign and submit the withdrawal intent, then wait for on-chain settlement.
 * The bridge releases the real tokens on the destination chain once settled.
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

  // Submit withdrawal intent without waiting for destination-chain indexing.
  // This avoids appearing stuck when destination status lags.
  const { intentHash } = await intentsSdk.signAndSendWithdrawalIntent({
    withdrawalParams,
    feeEstimation,
  });
  console.log(`Intent submitted: ${intentHash}`);

  // Wait for Near-side settlement first (usually fast).
  const intentTx = await intentsSdk.waitForIntentSettlement({
    intentHash,
  });

  // Destination indexing can lag even when funds already arrived.
  // Cap the wait so the script always returns promptly with useful hashes.
  let destinationTx: Array<{ hash: string | null }> | null = null;
  try {
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

// Configure multiple withdrawals to execute in one intent submission.
const withdrawals: WithdrawalConfig[] = [
  {
    tokenId: 'nep245:v2_1.omni.hot.tg:56_11111111111111111111', // BNB
    amount: '0.00002',
    destinationAddress: '0x70E93a63A6f2a85784bF71Ba1d3Ca745202f9B33',
  },
  // {
  //   tokenId: 'nep245:v2_1.omni.hot.tg:56_11111111111111111111', // BNB
  //   amount: '0.00002',
  //   destinationAddress: '0x70E93a63A6f2a85784bF71Ba1d3Ca745202f9B33',
  // },
  {
    tokenId: 'nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g', // USDT
    amount: '0.05',
    destinationAddress: '0x70E93a63A6f2a85784bF71Ba1d3Ca745202f9B33',
  },
];

const withdrawalQuoteOnly = false; // Set to true to only see fee quote without executing
const destinationWaitTimeoutMs = 120_000; // Limit destination wait to 2 minutes
const maxIntentComplexityPerBatch = 4; // Lower this if you still hit gas limits

const estimateIntentComplexity = (fee: FeeEstimation) => {
  // Quoted withdrawals include additional solver-signed intents.
  return fee.quote ? 3 : 1;
};

const buildBatches = ({
  resolvedWithdrawals,
  withdrawalParams,
  feeEstimation,
  maxComplexity,
}: {
  resolvedWithdrawals: ResolvedWithdrawal[];
  withdrawalParams: WithdrawalParams[];
  feeEstimation: FeeEstimation[];
  maxComplexity: number;
}): WithdrawalBatch[] => {
  const batches: WithdrawalBatch[] = [];

  let current: WithdrawalBatch = {
    withdrawalParams: [],
    feeEstimation: [],
    entries: [],
  };
  let currentComplexity = 0;

  for (let i = 0; i < withdrawalParams.length; i++) {
    const complexity = estimateIntentComplexity(feeEstimation[i]);
    const shouldFlush =
      current.withdrawalParams.length > 0 &&
      currentComplexity + complexity > maxComplexity;

    if (shouldFlush) {
      batches.push(current);
      current = {
        withdrawalParams: [],
        feeEstimation: [],
        entries: [],
      };
      currentComplexity = 0;
    }

    current.withdrawalParams.push(withdrawalParams[i]);
    current.feeEstimation.push(feeEstimation[i]);
    current.entries.push(resolvedWithdrawals[i]);
    currentComplexity += complexity;
  }

  if (current.withdrawalParams.length > 0) {
    batches.push(current);
  }

  return batches;
};

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

  console.log('Preparing batch withdrawal...');
  console.table(
    resolvedWithdrawals.map((entry) => ({
      token: entry.token.symbol,
      assetId: entry.token.assetId,
      amountHuman: entry.config.amount,
      amountSmallestUnit: entry.amountIn,
      destination: entry.config.destinationAddress,
      memo: entry.config.destinationMemo ?? '',
    })),
  );

  const withdrawalParams: WithdrawalParams[] = resolvedWithdrawals.map(
    (entry) => ({
      assetId: entry.token.assetId,
      amount: BigInt(entry.amountIn),
      destinationAddress: entry.config.destinationAddress,
      feeInclusive: true,
      destinationMemo: entry.config.destinationMemo,
    }),
  );

  // Phase 1: Get fee estimations for all configured withdrawals
  const feeEstimation = await intentsSdk.estimateWithdrawalFee({
    withdrawalParams,
  });

  const invalidFeeInclusiveRows = resolvedWithdrawals
    .map((entry, index) => {
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

  // Phase 2: Execute in gas-safe batches to avoid prepaid gas failures.
  const batches = buildBatches({
    resolvedWithdrawals,
    withdrawalParams,
    feeEstimation,
    maxComplexity: maxIntentComplexityPerBatch,
  });

  const results: Array<Awaited<ReturnType<typeof submitWithdrawal>>> = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`\nSubmitting batch ${i + 1}/${batches.length}...`);
    console.table(
      batch.entries.map((entry) => ({
        token: entry.token.symbol,
        assetId: entry.token.assetId,
        amountHuman: entry.config.amount,
      })),
    );

    const result = await submitWithdrawal({
      withdrawalParams: batch.withdrawalParams,
      feeEstimation: batch.feeEstimation,
      signer,
    });
    results.push(result);
  }

  console.log('\nAll withdrawal batches submitted. Settlement results:');
  console.log(JSON.stringify(results, null, 2));
}

// Only run when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
