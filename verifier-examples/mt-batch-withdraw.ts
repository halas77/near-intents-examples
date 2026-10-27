/**
 *  MT Batch Withdraw (NEP-245 Callback-Based Batch Withdrawal)
 *
 *  Submits a single `mt_withdraw` intent containing multiple NEP-245 token IDs
 *  and amounts with a nonempty `msg` field, causing the NEAR Intents execution
 *  path to invoke `mt_batch_transfer_call` on the receiving contract.
 *
 *  Why mt_batch_transfer_call?
 *  ---------------------------
 *  When the `msg` field is present in an `mt_withdraw` intent, the intents
 *  contract uses `mt_batch_transfer_call` instead of `mt_batch_transfer`.
 *  This triggers a callback (`mt_on_transfer`) on the receiver contract,
 *  allowing the receiver to process the batch and perform custom logic
 *  (e.g. bridge-refuel, cross-chain withdrawal).
 *
 *  Intent structure:
 *  -----------------
 *  Exactly ONE `mt_withdraw` intent with:
 *   - `token`       — the multi-token contract (e.g. `v2_1.omni.hot.tg`)
 *   - `receiver_id` — the NEAR contract that receives the callback
 *   - `token_ids`   — array of NEP-245 token IDs
 *   - `amounts`     — positionally-aligned array of amounts (string)
 *   - `msg`         — JSON string passed to `mt_batch_transfer_call`
 *   - `memo`        — optional memo
 *
 *  Safety:
 *  -------
 *  By default this script runs in DRY-RUN mode. Pass `--submit` to actually
 *  sign and publish the intent. A callback message can trigger contract
 *  behavior — only use with a trusted, understood receiver.
 *
 *  Environment variables:
 *   - MT_CONTRACT          — multi-token contract ID (default: v2_1.omni.hot.tg)
 *   - MT_RECEIVER_ID       — callback receiver contract
 *   - MT_TOKEN_IDS         — JSON array of token ID strings
 *   - MT_AMOUNTS           — JSON array of amount strings (positionally aligned)
 *   - MT_CALLBACK_MSG_JSON — JSON object for the callback `msg`
 *   - MT_MEMO              — optional memo string
 *   - MT_MIN_GAS           — optional min_gas (e.g. "50000000000000" for 50 TGas)
 *   - MT_STORAGE_DEPOSIT   — optional storage deposit in yoctoNEAR
 *
 *  Run:  pnpm sdk/mt-batch-withdraw           (dry-run)
 *  Run:  pnpm sdk/mt-batch-withdraw --submit  (live submission)
 *
 *  ⚠ WARNING: A callback message can trigger contract behavior on the receiver.
 *    Only use with a trusted, understood receiver contract.
 *    Do not hardcode production values. Do not submit real transactions in tests.
 */

import 'dotenv/config';
import { RouteEnum } from '@defuse-protocol/intents-sdk';
import { base58 } from '@scure/base';
import { fileURLToPath } from 'node:url';
import {
  type Chain,
  createPublicClient,
  fallback,
  hexToBytes,
  http,
  isAddress,
} from 'viem';
import { arbitrum, base, bsc, mainnet, optimism, polygon } from 'viem/chains';
import { intentsSdk } from './utils/config';
import { getSigner } from './utils/signer';

// ── Constants & Defaults ───────────────────────────────────────────────────────

/** Default destination address on the target chain if not specified */
export const DEFAULT_DESTINATION_ADDRESS =
  '0x70E93a63A6f2a85784bF71Ba1d3Ca745202f9B33';

/** Default native relayer fee in wei (0.01 MATIC / POL) */
export const DEFAULT_AMOUNT_NATIVE = '10000000000000000';

/**
 * Encode an EVM receiver address to the Base58 format expected by bridge-refuel.hot.tg.
 * The on-chain Rust contract decodes `receiver_id` via `bs58::decode()`.
 * Passing raw "0x..." causes the contract to panic with:
 * "provided string contained invalid character '0' at byte 0".
 */
export function encodeReceiverAddress(address: string): string {
  if (isAddress(address) && address.startsWith('0x')) {
    return base58.encode(hexToBytes(address as `0x${string}`));
  }
  return address;
}

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * Configuration for mt_batch_withdraw, loaded from environment variables.
 */
export interface MtBatchWithdrawConfig {
  /** Multi-token contract ID (NEP-245 contract) */
  mtContract: string;
  /** Callback receiver contract ID */
  receiverId: string;
  /** Array of NEP-245 token IDs */
  tokenIds: string[];
  /** Positionally-aligned array of amounts (as strings) */
  amounts: string[];
  /** Callback message JSON object (will be serialized to string) */
  callbackMsg: Record<string, unknown>;
  /** Optional memo */
  memo?: string;
  /** Optional min_gas override */
  minGas?: string;
  /** Optional storage deposit (yoctoNEAR) */
  storageDeposit?: string;
}

/**
 * The `IntentMtWithdraw` shape from @defuse-protocol/contract-types.
 *
 * When `msg` is provided, the intents contract invokes `mt_batch_transfer_call`.
 * When `msg` is absent/null, it invokes `mt_batch_transfer` instead.
 */
interface MtWithdrawIntent {
  intent: 'mt_withdraw';
  token: string;
  receiver_id: string;
  token_ids: string[];
  amounts: string[];
  msg?: string | null;
  memo?: string | null;
  min_gas?: string | null;
  storage_deposit?: string | null;
}

// ── Validation ─────────────────────────────────────────────────────────────────

/**
 * Validate a NEAR-style account ID (simplified check).
 * Accepts: implicit hex (64 chars), named accounts (alice.near), sub-accounts.
 */
function isValidAccountId(id: string): boolean {
  if (!id || id.length === 0 || id.length > 64) return false;
  // Implicit account (64 hex chars)
  if (/^[0-9a-f]{64}$/.test(id)) return true;
  // Named account: alphanumeric, -, _, . segments, minimum 2 chars, ending in valid TLD
  if (/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(id)) return true;
  return false;
}

/**
 * Validate that a string represents a valid positive integer amount.
 */
function isValidAmount(amount: string): boolean {
  if (!amount || amount.length === 0) return false;
  if (!/^\d+$/.test(amount)) return false;
  // Must be > 0
  return BigInt(amount) > 0n;
}

/**
 * Automatically resolve callback message parameters when MT_CALLBACK_MSG_JSON is omitted.
 *
 * Resolves:
 * - `receiver_id`: from options / MT_DESTINATION_ADDRESS / DEFAULT_DESTINATION_ADDRESS
 * - `amount_native`: from options / MT_AMOUNT_NATIVE / DEFAULT_AMOUNT_NATIVE
 * - `block_number`: fetched dynamically from the destination chain via SDK fee estimation
 *   (same method used by withdraw-tokens.ts) or directly via Viem RPC.
 */
export async function resolveAutoCallbackMsg(options?: {
  tokenId?: string;
  mtContract?: string;
  destinationAddress?: string;
  amountNative?: string;
  isSubmitMode?: boolean;
}): Promise<{
  receiver_id: string;
  amount_native: string;
  block_number: number;
}> {
  const rawReceiver =
    options?.destinationAddress ||
    process.env.MT_DESTINATION_ADDRESS ||
    DEFAULT_DESTINATION_ADDRESS;
  const receiverId = encodeReceiverAddress(rawReceiver);

  let amountNative =
    options?.amountNative ||
    process.env.MT_AMOUNT_NATIVE ||
    DEFAULT_AMOUNT_NATIVE;

  const mtContract =
    options?.mtContract || process.env.MT_CONTRACT || 'v2_1.omni.hot.tg';

  let blockNumber: number | null = null;

  // Check if explicit block number override is provided in env
  if (
    process.env.MT_BLOCK_NUMBER &&
    /^\d+$/.test(process.env.MT_BLOCK_NUMBER)
  ) {
    blockNumber = parseInt(process.env.MT_BLOCK_NUMBER, 10);
  }

  // Method 1: Try SDK estimateWithdrawalFee (as in withdraw-tokens.ts)
  if (blockNumber === null && options?.tokenId) {
    try {
      const assetId = options.tokenId.startsWith('nep245:')
        ? options.tokenId
        : `nep245:${mtContract}:${options.tokenId}`;

      const fee = await intentsSdk.estimateWithdrawalFee({
        withdrawalParams: {
          assetId,
          amount: 10000n,
          destinationAddress: receiverId,
          feeInclusive: true,
        },
      });

      const hotBridgeFee = (
        fee.underlyingFees as Record<
          string,
          { blockNumber?: bigint; relayerFee?: bigint }
        >
      )?.[RouteEnum.HotBridge];

      if (
        hotBridgeFee?.blockNumber !== undefined &&
        hotBridgeFee.blockNumber !== null
      ) {
        blockNumber = Number(hotBridgeFee.blockNumber);
        if (
          hotBridgeFee.relayerFee &&
          !options?.amountNative &&
          !process.env.MT_AMOUNT_NATIVE
        ) {
          amountNative = hotBridgeFee.relayerFee.toString();
        }
      }
    } catch {
      // Fallback to Viem RPC if SDK estimation is unavailable
    }
  }

  // Method 2: Try Viem RPC for destination EVM chain
  if (blockNumber === null) {
    try {
      // Detect chain ID from tokenId prefix, e.g. "137_qiStmoQJDQPTebaPjgx5VBxZv6L" -> 137
      const chainIdMatch = options?.tokenId?.match(/^(\d+)_/);
      const chainId = chainIdMatch ? parseInt(chainIdMatch[1], 10) : 137;

      const chainMap: Record<number, Chain> = {
        137: polygon,
        1: mainnet,
        56: bsc,
        42161: arbitrum,
        8453: base,
        10: optimism,
      };
      const chain = chainMap[chainId] || polygon;

      // Provide redundant public RPC endpoints for Polygon to handle rate limits
      const transports =
        chainId === 137
          ? fallback([
              http('https://polygon-rpc.com'),
              http('https://rpc.ankr.com/polygon'),
              http('https://1rpc.io/matic'),
              http('https://polygon.gateway.tenderly.co'),
            ])
          : http();

      const client = createPublicClient({ chain, transport: transports });
      const bn = await client.getBlockNumber();
      blockNumber = Number(bn);
    } catch {
      // Fallback below
    }
  }

  if (blockNumber === null) {
    if (!options?.isSubmitMode) {
      // Graceful fallback for dry-run preview when offline / sandboxed / rate-limited
      const fallbackBlock = 68420150;
      console.warn(
        '⚠  Notice: Destination RPC was unreachable (offline or rate-limited).',
      );
      console.warn(
        `   Using reference block height ${fallbackBlock} for dry-run preview.`,
      );
      console.warn(
        '   For live submission, ensure internet access or set MT_BLOCK_NUMBER in .env.\n',
      );
      blockNumber = fallbackBlock;
    } else {
      throw new Error(
        'Could not automatically determine the destination block number from network. ' +
          'Live submission requires network access or setting MT_BLOCK_NUMBER / MT_CALLBACK_MSG_JSON.',
      );
    }
  }

  return {
    receiver_id: receiverId,
    amount_native: amountNative,
    block_number: blockNumber,
  };
}

/**
 * Load and validate configuration from environment variables.
 *
 * @param autoCallbackMsg Optional pre-resolved callback message when MT_CALLBACK_MSG_JSON is not set.
 */
export function loadConfig(
  autoCallbackMsg?: Record<string, unknown>,
): MtBatchWithdrawConfig {
  const mtContract = process.env.MT_CONTRACT || 'v2_1.omni.hot.tg';

  const receiverId = process.env.MT_RECEIVER_ID;
  if (!receiverId) {
    throw new Error(
      'MT_RECEIVER_ID is required. Set it to the callback receiver contract ' +
        '(e.g. bridge-refuel.hot.tg). This is the NEAR contract that will ' +
        'receive the mt_batch_transfer_call callback.',
    );
  }
  if (!isValidAccountId(receiverId)) {
    throw new Error(
      `MT_RECEIVER_ID "${receiverId}" is not a valid NEAR account ID.`,
    );
  }

  // Parse token IDs
  const tokenIdsRaw = process.env.MT_TOKEN_IDS;
  if (!tokenIdsRaw) {
    throw new Error(
      'MT_TOKEN_IDS is required. Provide a JSON array of NEP-245 token IDs. ' +
        'Example: MT_TOKEN_IDS=\'["137_qiStmoQJDQPTebaPjgx5VBxZv6L","137_3hpYoaLtt8MP1Z2GH1U473DMRKgr"]\'',
    );
  }
  let tokenIds: string[];
  try {
    tokenIds = JSON.parse(tokenIdsRaw);
  } catch {
    throw new Error(`MT_TOKEN_IDS is not valid JSON: ${tokenIdsRaw}`);
  }
  if (!Array.isArray(tokenIds)) {
    throw new Error('MT_TOKEN_IDS must be a JSON array of strings.');
  }
  if (tokenIds.length < 2) {
    throw new Error(
      'MT_TOKEN_IDS must contain at least 2 token IDs for a batch withdrawal.',
    );
  }
  for (let i = 0; i < tokenIds.length; i++) {
    if (typeof tokenIds[i] !== 'string' || tokenIds[i].length === 0) {
      throw new Error(`MT_TOKEN_IDS[${i}] is empty or not a string.`);
    }
  }

  // Parse amounts
  const amountsRaw = process.env.MT_AMOUNTS;
  if (!amountsRaw) {
    throw new Error(
      'MT_AMOUNTS is required. Provide a JSON array of amount strings, ' +
        'positionally aligned with MT_TOKEN_IDS. ' +
        'Example: MT_AMOUNTS=\'["100","200"]\'',
    );
  }
  let amounts: string[];
  try {
    amounts = JSON.parse(amountsRaw);
  } catch {
    throw new Error(`MT_AMOUNTS is not valid JSON: ${amountsRaw}`);
  }
  if (!Array.isArray(amounts)) {
    throw new Error('MT_AMOUNTS must be a JSON array of strings.');
  }
  if (amounts.length !== tokenIds.length) {
    throw new Error(
      `MT_AMOUNTS length (${amounts.length}) does not match ` +
        `MT_TOKEN_IDS length (${tokenIds.length}). Arrays must be positionally aligned.`,
    );
  }
  for (let i = 0; i < amounts.length; i++) {
    const amount = String(amounts[i]);
    amounts[i] = amount; // normalize numbers to strings
    if (!isValidAmount(amount)) {
      throw new Error(
        `MT_AMOUNTS[${i}] = "${amounts[i]}" is not a valid positive integer amount.`,
      );
    }
  }

  // Parse callback message
  let callbackMsg: Record<string, unknown>;
  const callbackMsgRaw = process.env.MT_CALLBACK_MSG_JSON;
  if (callbackMsgRaw) {
    try {
      callbackMsg = JSON.parse(callbackMsgRaw);
    } catch {
      throw new Error(
        `MT_CALLBACK_MSG_JSON is not valid JSON: ${callbackMsgRaw}`,
      );
    }
    if (
      callbackMsg === null ||
      typeof callbackMsg !== 'object' ||
      Array.isArray(callbackMsg)
    ) {
      throw new Error(
        'MT_CALLBACK_MSG_JSON must be a JSON object (not null, not an array).',
      );
    }
  } else if (autoCallbackMsg) {
    callbackMsg = autoCallbackMsg;
  } else {
    throw new Error(
      'MT_CALLBACK_MSG_JSON is required. Provide a JSON object for the callback message. ' +
        'This is passed as the `msg` field to `mt_batch_transfer_call`. ' +
        'Example: MT_CALLBACK_MSG_JSON=\'{"receiver_id":"dest.near","amount_native":"1000"}\'',
    );
  }

  // If callback contract is bridge-refuel.hot.tg and receiver_id inside msg is an EVM address ("0x..."),
  // convert it to the Base58 format expected by the Rust smart contract.
  if (
    receiverId === 'bridge-refuel.hot.tg' &&
    typeof callbackMsg.receiver_id === 'string' &&
    callbackMsg.receiver_id.startsWith('0x')
  ) {
    callbackMsg.receiver_id = encodeReceiverAddress(callbackMsg.receiver_id);
  }

  // Validate NEAR account ID in MT_CONTRACT
  if (!isValidAccountId(mtContract)) {
    throw new Error(
      `MT_CONTRACT "${mtContract}" is not a valid NEAR account ID.`,
    );
  }

  const memo = process.env.MT_MEMO || undefined;
  const minGas = process.env.MT_MIN_GAS || undefined;
  const storageDeposit = process.env.MT_STORAGE_DEPOSIT || undefined;

  if (minGas && !/^\d+$/.test(minGas)) {
    throw new Error(`MT_MIN_GAS "${minGas}" is not a valid integer.`);
  }
  if (storageDeposit && !/^\d+$/.test(storageDeposit)) {
    throw new Error(
      `MT_STORAGE_DEPOSIT "${storageDeposit}" is not a valid integer.`,
    );
  }

  return {
    mtContract,
    receiverId,
    tokenIds,
    amounts,
    callbackMsg,
    memo,
    minGas,
    storageDeposit,
  };
}

// ── Intent Construction ────────────────────────────────────────────────────────

/**
 * Build the single `mt_withdraw` intent primitive from the validated config.
 *
 * This intent, when signed and submitted, causes the intents contract to call
 * `mt_batch_transfer_call` on the multi-token contract, which in turn invokes
 * `mt_on_transfer` on the `receiver_id` with the full batch and `msg`.
 */
export function buildMtWithdrawIntent(
  config: MtBatchWithdrawConfig,
): MtWithdrawIntent {
  const msgString = JSON.stringify(config.callbackMsg);

  const intent: MtWithdrawIntent = {
    intent: 'mt_withdraw',
    token: config.mtContract,
    receiver_id: config.receiverId,
    token_ids: config.tokenIds,
    amounts: config.amounts,
    msg: msgString,
    memo: config.memo ?? null,
    min_gas: config.minGas ?? null,
    storage_deposit: config.storageDeposit ?? null,
  };

  return intent;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const isSubmitMode = process.argv.includes('--submit');

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  MT Batch Withdraw — NEP-245 Callback-Based Withdrawal  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log();

  // If MT_CALLBACK_MSG_JSON is not provided, automatically resolve receiver_id,
  // amount_native, and live destination block_number.
  let autoCallbackMsg: Record<string, unknown> | undefined;
  if (!process.env.MT_CALLBACK_MSG_JSON) {
    console.log(
      'ℹ  MT_CALLBACK_MSG_JSON not set — automatically resolving receiver_id, amount_native, and live block_number...',
    );
    let firstTokenId: string | undefined;
    try {
      const raw = process.env.MT_TOKEN_IDS;
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length > 0) {
          firstTokenId = String(arr[0]);
        }
      }
    } catch {
      // Ignore JSON parse errors here; loadConfig will report them cleanly
    }

    autoCallbackMsg = await resolveAutoCallbackMsg({
      tokenId: firstTokenId,
      isSubmitMode,
    });
    console.log(
      '   Auto-resolved callback msg:',
      JSON.stringify(autoCallbackMsg),
    );
    console.log();
  }

  // Load and validate configuration
  const config = loadConfig(autoCallbackMsg);
  const intent = buildMtWithdrawIntent(config);

  // Display the proposed intent
  console.log('Multi-token contract:', config.mtContract);
  console.log('Callback receiver:  ', config.receiverId);
  console.log('Token IDs:          ', config.tokenIds);
  console.log('Amounts:            ', config.amounts);
  console.log('Callback msg:       ', JSON.stringify(config.callbackMsg));
  if (config.memo) console.log('Memo:               ', config.memo);
  if (config.minGas) console.log('Min gas:            ', config.minGas);
  if (config.storageDeposit)
    console.log('Storage deposit:    ', config.storageDeposit);
  console.log();

  // Show the exact intent payload
  console.log('─── Proposed Intent ───');
  const intentPayload = {
    intents: [intent],
  };
  console.log(JSON.stringify(intentPayload, null, 2));
  console.log('───────────────────────');
  console.log();

  // Warn about callback behavior
  console.log(
    '⚠  WARNING: The `msg` field triggers `mt_batch_transfer_call` on the',
  );
  console.log(
    '   multi-token contract, which invokes `mt_on_transfer` on the receiver.',
  );
  console.log(
    '   This can trigger contract behavior. Only use with a trusted receiver.',
  );
  console.log();

  if (!isSubmitMode) {
    console.log('🔒 DRY-RUN MODE — no signing or submission performed.');
    console.log(
      '   To submit for real, re-run with: pnpm sdk/mt-batch-withdraw --submit',
    );
    return;
  }

  // ── Live Submission ──────────────────────────────────────────────────

  console.log('🔑 LIVE MODE — signing and submitting the intent...');
  console.log();

  // Auto-detect signer type (NEAR or EVM) based on which .env key is set
  const { signer } = await getSigner();
  if (!signer) {
    throw new Error('Signer not found');
  }

  // Attach signer to SDK
  intentsSdk.setIntentSigner(signer);

  // Sign and submit the intent using the low-level signAndSendIntent API.
  // This accepts raw IntentPrimitive[] and handles nonce generation,
  // signing, and relay submission.
  console.log('Signing and submitting 1 intent with mt_withdraw...');
  const { intentHash } = await intentsSdk.signAndSendIntent({
    intents: [intent],
  });
  console.log(`✅ Intent submitted: ${intentHash}`);

  // Wait for settlement on NEAR
  console.log('Waiting for intent settlement on NEAR...');
  const intentTx = await intentsSdk.waitForIntentSettlement({
    intentHash,
    signal: AbortSignal.timeout(120_000), // 2 minute timeout
  });
  console.log(`✅ NEAR intent settled! Tx: ${intentTx.hash}`);
  console.log(
    `   View on NearBlocks: https://nearblocks.io/txns/${intentTx.hash}`,
  );

  console.log();
  console.log('─── Settlement Result ───');
  console.log(
    JSON.stringify(
      {
        intentHash,
        intentTx,
      },
      null,
      2,
    ),
  );
  console.log('─────────────────────────');

  console.log();
  console.log('📋 Verify on NearBlocks that the transaction includes an');
  console.log('   `mt_batch_transfer_call` action with the full token batch.');
  console.log(
    '   See the NearBlocks verification checklist in the documentation.',
  );
}

// Only run when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
