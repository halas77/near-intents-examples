import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { hexToBytes, isAddress } from 'viem';
import { base58 } from '@scure/base';
import { intentsSdk } from './utils/config';
import { getSigner } from './utils/signer';

type UnknownObject = Record<string, unknown>;

interface MtWithdrawIntent {
  intent: 'mt_withdraw';
  token: string;
  receiver_id: string;
  token_ids: string[];
  amounts: string[];
  msg: string;
  memo: string | null;
  min_gas: string | null;
  storage_deposit: string | null;
}

interface TxOutcome {
  result: {
    receipts_outcome: Array<{
      id: string;
      outcome: {
        executor_id: string;
        logs: string[];
        status: {
          SuccessValue?: string;
          SuccessReceiptId?: string;
          Failure?: unknown;
        };
      };
    }>;
  };
}

interface CaseResult {
  name: string;
  intentHash?: string;
  txHash?: string;
  mtOnTransferUnused?: string[];
  withdrawStarted: boolean;
  refundApplied: boolean;
  likelyDesync: boolean;
  note: string;
}

interface HunterCase {
  name: string;
  msgObject?: UnknownObject;
  rawMsg?: string;
}

const DEFAULT_MT_CONTRACT = process.env.MT_CONTRACT || 'v2_1.omni.hot.tg';
const DEFAULT_RECEIVER = process.env.MT_RECEIVER_ID || 'bridge-refuel.hot.tg';
const DEFAULT_MIN_GAS = process.env.MT_MIN_GAS || '1000';

const DEFAULT_TOKEN_IDS = [
  '137_qiStmoQJDQPTebaPjgx5VBxZv6L',
  '56_2w93GqMcEmQFDru84j3HZZWt557r',
];

const DEFAULT_AMOUNTS = ['2000', '1000000000000000'];

const BASE_RECEIVER_HEX =
  process.env.MT_DESTINATION_ADDRESS ||
  '0x70E93a63A6f2a85784bF71Ba1d3Ca745202f9B33';

function encodeReceiverAddress(address: string): string {
  if (isAddress(address) && address.startsWith('0x')) {
    return base58.encode(hexToBytes(address as `0x${string}`));
  }
  return address;
}

function parseArrayEnv(key: string, fallback: string[]): string[] {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string')) {
    throw new Error(`${key} must be JSON string array`);
  }
  return parsed;
}

function decodeSuccessValueBase64(successValue?: string): string {
  if (!successValue) return '';
  if (successValue.length === 0) return '';
  try {
    return Buffer.from(successValue, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

async function fetchTxOutcome(
  txHash: string,
  accountId: string,
): Promise<TxOutcome> {
  const res = await fetch('https://rpc.mainnet.near.org', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'desync-hunter',
      method: 'tx',
      params: [txHash, accountId],
    }),
  });
  const json = (await res.json()) as TxOutcome | { error: unknown };
  if ('error' in json) {
    throw new Error(`RPC tx query failed for ${txHash}`);
  }
  return json;
}

function parseUnusedFromBridgeReceipt(
  outcome: TxOutcome,
): string[] | undefined {
  const bridgeReceipt = outcome.result.receipts_outcome.find(
    (r) => r.outcome.executor_id === 'bridge-refuel.hot.tg',
  );
  if (!bridgeReceipt) return undefined;
  const decoded = decodeSuccessValueBase64(
    bridgeReceipt.outcome.status.SuccessValue,
  );
  if (!decoded) return undefined;
  try {
    const parsed = JSON.parse(decoded);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function analyzeOutcome(
  outcome: TxOutcome,
  mtOnTransferUnused?: string[],
): {
  withdrawStarted: boolean;
  refundApplied: boolean;
  likelyDesync: boolean;
  note: string;
} {
  const allLogs = outcome.result.receipts_outcome.flatMap((r) =>
    r.outcome.logs.map((l) => ({ executor: r.outcome.executor_id, log: l })),
  );

  const withdrawStarted = allLogs.some(
    ({ executor, log }) =>
      executor === 'v2_1.omni.hot.tg' &&
      log.includes('"event":"mt_burn"') &&
      log.includes('"owner_id":"bridge-refuel.hot.tg"'),
  );

  const refundApplied = allLogs.some(
    ({ log }) =>
      (log.includes('"event":"mt_transfer"') &&
        log.includes('"memo":"refund"')) ||
      (log.includes('"event":"mt_mint"') && log.includes('"memo":"refund"')),
  );

  const unused0 = mtOnTransferUnused?.[0] ?? '0';
  const nonZeroUnused0 = (() => {
    try {
      return BigInt(unused0) > 0n;
    } catch {
      return false;
    }
  })();

  const likelyDesync = withdrawStarted && nonZeroUnused0;

  let note = 'No contradiction observed';
  if (likelyDesync) {
    note = 'Potential desync: withdraw_started && mt_on_transfer_unused[0] > 0';
  } else if (withdrawStarted && !refundApplied && !nonZeroUnused0) {
    note = 'Withdraw path started with zero-unused return';
  } else if (!withdrawStarted && refundApplied) {
    note = 'Early refund path (likely mt_on_transfer panic/failure)';
  } else if (withdrawStarted && refundApplied) {
    note =
      'Withdraw started and refund logs exist (inspect ordering carefully)';
  }

  return { withdrawStarted, refundApplied, likelyDesync, note };
}

function substituteReceiverPlaceholder(
  value: unknown,
  baseReceiverId: string,
): unknown {
  if (typeof value === 'string') {
    return value.replaceAll('__BASE58_RECEIVER__', baseReceiverId);
  }

  if (Array.isArray(value)) {
    return value.map((v) => substituteReceiverPlaceholder(v, baseReceiverId));
  }

  if (value && typeof value === 'object') {
    const replaced: UnknownObject = {};
    for (const [k, v] of Object.entries(value as UnknownObject)) {
      replaced[k] = substituteReceiverPlaceholder(v, baseReceiverId);
    }
    return replaced;
  }

  return value;
}

function buildCases(baseReceiverId: string): HunterCase[] {
  return [
    {
      name: 'baseline-valid',
      msgObject: {
        amount_native: '2',
        receiver_id: baseReceiverId,
        block_number: 100,
      },
    },
    {
      name: 'extra-keys-soft-flags',
      msgObject: {
        amount_native: '2',
        receiver_id: baseReceiverId,
        block_number: 100,
        policy: 'optimistic_withdraw_then_settle',
        settlement: 'refund_if_uncertain',
        strict: false,
      },
    },
    {
      name: 'max-block-window',
      msgObject: {
        amount_native: '2',
        receiver_id: baseReceiverId,
        block_number: 4294967296,
        window: 'strict',
      },
    },
    {
      name: 'type-flip-block-string',
      msgObject: {
        amount_native: '2',
        receiver_id: baseReceiverId,
        block_number: '100',
        mode: 'typeflip',
      },
    },
  ];
}

function parseCustomCases(baseReceiverId: string): HunterCase[] | null {
  const raw = process.env.DESYNC_CASES_JSON;
  if (!raw) return null;

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('DESYNC_CASES_JSON must be a JSON array');
  }

  const normalized: HunterCase[] = parsed.map((item, index) => {
    const defaultName = `custom-${index + 1}`;

    // Raw msg payload (string entry): allows duplicate keys and exact ordering.
    if (typeof item === 'string') {
      return {
        name: defaultName,
        rawMsg: item.replaceAll('__BASE58_RECEIVER__', baseReceiverId),
      };
    }

    if (typeof item !== 'object' || item === null) {
      throw new Error(
        `DESYNC_CASES_JSON[${index}] must be object or string raw msg`,
      );
    }

    const maybeNamed = item as {
      name?: unknown;
      msg?: unknown;
      rawMsg?: unknown;
    };
    const name =
      typeof maybeNamed.name === 'string' ? maybeNamed.name : defaultName;

    if (typeof maybeNamed.rawMsg === 'string') {
      return {
        name,
        rawMsg: maybeNamed.rawMsg.replaceAll(
          '__BASE58_RECEIVER__',
          baseReceiverId,
        ),
      };
    }

    // Convenience: when msg is string, treat it as raw payload.
    if (typeof maybeNamed.msg === 'string') {
      return {
        name,
        rawMsg: maybeNamed.msg.replaceAll(
          '__BASE58_RECEIVER__',
          baseReceiverId,
        ),
      };
    }

    if (maybeNamed.msg && typeof maybeNamed.msg === 'object') {
      const replaced = substituteReceiverPlaceholder(
        maybeNamed.msg,
        baseReceiverId,
      );
      return { name, msgObject: replaced as UnknownObject };
    }

    // Backward-compatible shorthand: object entry itself is msg object.
    const replaced = substituteReceiverPlaceholder(item, baseReceiverId);
    return { name, msgObject: replaced as UnknownObject };
  });

  return normalized;
}

function toCsv(results: CaseResult[]): string {
  const escape = (v: string) => `"${v.replaceAll('"', '""')}"`;
  const header = [
    'name',
    'intentHash',
    'txHash',
    'unused0',
    'unusedRaw',
    'withdrawStarted',
    'refundApplied',
    'likelyDesync',
    'note',
  ];

  const rows = results.map((r) => {
    const unused0 = r.mtOnTransferUnused?.[0] ?? '';
    const unusedRaw = r.mtOnTransferUnused
      ? JSON.stringify(r.mtOnTransferUnused)
      : '';
    return [
      r.name,
      r.intentHash ?? '',
      r.txHash ?? '',
      unused0,
      unusedRaw,
      String(r.withdrawStarted),
      String(r.refundApplied),
      String(r.likelyDesync),
      r.note,
    ]
      .map(escape)
      .join(',');
  });

  return `${header.join(',')}\n${rows.join('\n')}\n`;
}

async function maybeWriteReports(results: CaseResult[]): Promise<void> {
  const jsonPath = process.env.DESYNC_REPORT_JSON;
  const csvPath = process.env.DESYNC_REPORT_CSV;

  if (jsonPath) {
    await writeFile(jsonPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
    console.log(`Saved JSON report: ${jsonPath}`);
  }

  if (csvPath) {
    await writeFile(csvPath, toCsv(results), 'utf8');
    console.log(`Saved CSV report: ${csvPath}`);
  }
}

function getCaseMsgString(testCase: HunterCase): string {
  if (typeof testCase.rawMsg === 'string') {
    return testCase.rawMsg;
  }
  if (testCase.msgObject && typeof testCase.msgObject === 'object') {
    return JSON.stringify(testCase.msgObject);
  }
  throw new Error(`Case "${testCase.name}" missing msgObject/rawMsg`);
}

function buildIntent(args: {
  mtContract: string;
  receiverId: string;
  tokenIds: string[];
  amounts: string[];
  msgString: string;
  minGas: string;
}): MtWithdrawIntent {
  return {
    intent: 'mt_withdraw',
    token: args.mtContract,
    receiver_id: args.receiverId,
    token_ids: args.tokenIds,
    amounts: args.amounts,
    msg: args.msgString,
    memo: null,
    min_gas: args.minGas,
    storage_deposit: null,
  };
}

async function runCase(
  testCase: HunterCase,
  config: {
    mtContract: string;
    receiverId: string;
    tokenIds: string[];
    amounts: string[];
    minGas: string;
  },
): Promise<CaseResult> {
  const intent = buildIntent({
    mtContract: config.mtContract,
    receiverId: config.receiverId,
    tokenIds: config.tokenIds,
    amounts: config.amounts,
    msgString: getCaseMsgString(testCase),
    minGas: config.minGas,
  });

  const { intentHash } = await intentsSdk.signAndSendIntent({
    intents: [intent],
  });
  const settled = await intentsSdk.waitForIntentSettlement({
    intentHash,
    signal: AbortSignal.timeout(180_000),
  });

  const outcome = await fetchTxOutcome(settled.hash, settled.accountId);
  const mtOnTransferUnused = parseUnusedFromBridgeReceipt(outcome);
  const analysis = analyzeOutcome(outcome, mtOnTransferUnused);

  return {
    name: testCase.name,
    intentHash,
    txHash: settled.hash,
    mtOnTransferUnused,
    ...analysis,
  };
}

async function main() {
  const submit = process.argv.includes('--submit');
  const failOnFind =
    process.argv.includes('--fail-on-find') ||
    process.env.DESYNC_FAIL_ON_FIND === 'true';

  const tokenIds = parseArrayEnv('MT_TOKEN_IDS', DEFAULT_TOKEN_IDS);
  const amounts = parseArrayEnv('MT_AMOUNTS', DEFAULT_AMOUNTS);

  if (tokenIds.length !== amounts.length) {
    throw new Error('MT_TOKEN_IDS and MT_AMOUNTS must have equal length');
  }

  const encodedReceiver = encodeReceiverAddress(BASE_RECEIVER_HEX);
  const defaultCases = buildCases(encodedReceiver);
  const customCases = parseCustomCases(encodedReceiver);
  const cases = customCases ?? defaultCases;
  const maxCases = Number(process.env.DESYNC_MAX_CASES || `${cases.length}`);
  const selectedCases = cases.slice(
    0,
    Number.isFinite(maxCases) ? maxCases : cases.length,
  );

  console.log('=== Desync hunter configuration ===');
  console.log('mtContract     :', DEFAULT_MT_CONTRACT);
  console.log('receiverId     :', DEFAULT_RECEIVER);
  console.log('tokenIds       :', tokenIds);
  console.log('amounts        :', amounts);
  console.log('minGas         :', DEFAULT_MIN_GAS);
  console.log(
    'cases          :',
    selectedCases.map((c) => c.name),
  );
  console.log('mode           :', submit ? 'LIVE --submit' : 'DRY-RUN');
  console.log(
    'customCases    :',
    customCases ? `yes (${customCases.length})` : 'no',
  );
  console.log('failOnFind     :', failOnFind);
  console.log('===================================\n');

  if (!submit) {
    for (const c of selectedCases) {
      console.log(`[dry-run] ${c.name}`);
      console.log(getCaseMsgString(c));
    }
    console.log('\nPass --submit to execute on-chain.');
    return;
  }

  const { signer } = await getSigner();
  intentsSdk.setIntentSigner(signer);

  const results: CaseResult[] = [];

  for (const c of selectedCases) {
    console.log(`\n>>> Running case: ${c.name}`);
    try {
      const result = await runCase(c, {
        mtContract: DEFAULT_MT_CONTRACT,
        receiverId: DEFAULT_RECEIVER,
        tokenIds,
        amounts,
        minGas: DEFAULT_MIN_GAS,
      });
      results.push(result);

      console.log('intentHash      :', result.intentHash);
      console.log('txHash          :', result.txHash);
      console.log(
        'mt_on_transfer  :',
        result.mtOnTransferUnused ?? '(unavailable)',
      );
      console.log('withdrawStarted :', result.withdrawStarted);
      console.log('refundApplied   :', result.refundApplied);
      console.log('likelyDesync    :', result.likelyDesync);
      console.log('note            :', result.note);
    } catch (error) {
      results.push({
        name: c.name,
        withdrawStarted: false,
        refundApplied: false,
        likelyDesync: false,
        note: `Execution error: ${error instanceof Error ? error.message : String(error)}`,
      });
      console.log('error:', error);
    }
  }

  console.log('\n=== Summary ===');
  for (const r of results) {
    console.log(
      `${r.name.padEnd(24)} | desync=${String(r.likelyDesync).padEnd(5)} | unused0=${r.mtOnTransferUnused?.[0] ?? '-'} | withdraw=${r.withdrawStarted} | refund=${r.refundApplied}`,
    );
  }

  const found = results.filter((r) => r.likelyDesync);
  console.log('\nPotential desync findings:', found.length);
  if (found.length > 0) {
    console.log('Investigate tx hashes:');
    for (const f of found) {
      console.log(`- ${f.txHash} (${f.name})`);
    }
  }

  await maybeWriteReports(results);

  if (failOnFind && found.length > 0) {
    console.error('\nFailing because desync findings were detected.');
    process.exit(2);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
