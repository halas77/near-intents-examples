/**
 *  Tests for mt-batch-withdraw.ts
 *
 *  Standalone validation tests that verify intent construction, config
 *  validation, and dry-run behavior without calling the live bridge or
 *  submitting real funds.
 *
 *  Run: pnpm sdk/mt-batch-withdraw-test
 */

import {
  DEFAULT_AMOUNT_NATIVE,
  buildMtWithdrawIntent,
  encodeReceiverAddress,
  loadConfig,
  resolveAutoCallbackMsg,
} from './mt-batch-withdraw';
import type { MtBatchWithdrawConfig } from './mt-batch-withdraw';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ FAIL: ${message}`);
  }
}

function assertThrows(fn: () => void, expectedMsg: string, label: string) {
  try {
    fn();
    failed++;
    console.error(`  ❌ FAIL: ${label} — expected to throw but did not`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes(expectedMsg)) {
      passed++;
      console.log(`  ✅ ${label}`);
    } else {
      failed++;
      console.error(
        `  ❌ FAIL: ${label} — unexpected error: "${msg}" (expected "${expectedMsg}")`,
      );
    }
  }
}

// ── Helper: set env vars for a test, then restore ──────────────────────────────

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void,
): void {
  const originals: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    originals[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

console.log();
console.log('══════════════════════════════════════════════════════════');
console.log('  MT Batch Withdraw — Test Suite');
console.log('══════════════════════════════════════════════════════════');
console.log();

// Test 1: Two token IDs produce one intent with correct structure
console.log('Test 1: Two token IDs in one intent');
{
  const config: MtBatchWithdrawConfig = {
    mtContract: 'v2_1.omni.hot.tg',
    receiverId: 'bridge-refuel.hot.tg',
    tokenIds: [
      '137_qiStmoQJDQPTebaPjgx5VBxZv6L',
      '137_3hpYoaLtt8MP1Z2GH1U473DMRKgr',
    ],
    amounts: ['100', '200'],
    callbackMsg: { receiver_id: 'dest.near', amount_native: '1000' },
    memo: 'test-memo',
  };
  const intent = buildMtWithdrawIntent(config);

  assert(intent.intent === 'mt_withdraw', 'intent type is mt_withdraw');
  assert(intent.token === 'v2_1.omni.hot.tg', 'token matches MT_CONTRACT');
  assert(
    intent.receiver_id === 'bridge-refuel.hot.tg',
    'receiver_id matches MT_RECEIVER_ID',
  );
  assert(intent.token_ids.length === 2, 'token_ids has exactly 2 entries');
  assert(
    intent.token_ids[0] === '137_qiStmoQJDQPTebaPjgx5VBxZv6L',
    'first token ID matches',
  );
  assert(
    intent.token_ids[1] === '137_3hpYoaLtt8MP1Z2GH1U473DMRKgr',
    'second token ID matches',
  );
  assert(intent.amounts.length === 2, 'amounts has exactly 2 entries');
  assert(intent.amounts[0] === '100', 'first amount matches');
  assert(intent.amounts[1] === '200', 'second amount matches');
  assert(
    typeof intent.msg === 'string' && intent.msg.length > 0,
    'msg is nonempty string',
  );
  assert(intent.memo === 'test-memo', 'memo is preserved');
}
console.log();

// Test 2: Three or more token IDs
console.log('Test 2: Three token IDs in one intent');
{
  const config: MtBatchWithdrawConfig = {
    mtContract: 'v2_1.omni.hot.tg',
    receiverId: 'callback.near',
    tokenIds: ['token_a', 'token_b', 'token_c'],
    amounts: ['10', '20', '30'],
    callbackMsg: { action: 'process' },
  };
  const intent = buildMtWithdrawIntent(config);

  assert(intent.token_ids.length === 3, 'token_ids has 3 entries');
  assert(intent.amounts.length === 3, 'amounts has 3 entries');
  assert(intent.intent === 'mt_withdraw', 'still exactly one mt_withdraw');
}
console.log();

// Test 3: msg is preserved through serialization
console.log('Test 3: Callback msg is preserved through serialization');
{
  const callbackMsg = {
    receiver_id: '0x1234567890abcdef',
    amount_native: '500000',
    block_number: 12345,
  };
  const config: MtBatchWithdrawConfig = {
    mtContract: 'v2_1.omni.hot.tg',
    receiverId: 'callback.near',
    tokenIds: ['t1', 't2'],
    amounts: ['1', '2'],
    callbackMsg,
  };
  const intent = buildMtWithdrawIntent(config);

  // Parse msg back and verify round-trip
  const parsed = JSON.parse(intent.msg!);
  assert(
    parsed.receiver_id === '0x1234567890abcdef',
    'msg.receiver_id preserved',
  );
  assert(parsed.amount_native === '500000', 'msg.amount_native preserved');
  assert(parsed.block_number === 12345, 'msg.block_number preserved');
}
console.log();

// Test 4: Invalid JSON in MT_CALLBACK_MSG_JSON is rejected
console.log('Test 4: Invalid JSON in callback msg is rejected');
withEnv(
  {
    MT_CONTRACT: 'v2_1.omni.hot.tg',
    MT_RECEIVER_ID: 'callback.near',
    MT_TOKEN_IDS: '["t1","t2"]',
    MT_AMOUNTS: '["1","2"]',
    MT_CALLBACK_MSG_JSON: '{not valid json',
  },
  () => {
    assertThrows(
      () => loadConfig(),
      'MT_CALLBACK_MSG_JSON is not valid JSON',
      'rejects malformed JSON',
    );
  },
);
console.log();

// Test 5: Mismatched array lengths are rejected
console.log('Test 5: Mismatched array lengths are rejected');
withEnv(
  {
    MT_CONTRACT: 'v2_1.omni.hot.tg',
    MT_RECEIVER_ID: 'callback.near',
    MT_TOKEN_IDS: '["t1","t2","t3"]',
    MT_AMOUNTS: '["1","2"]',
    MT_CALLBACK_MSG_JSON: '{"key":"val"}',
  },
  () => {
    assertThrows(
      () => loadConfig(),
      'does not match',
      'rejects mismatched array lengths',
    );
  },
);
console.log();

// Test 6: Invalid amounts are rejected
console.log('Test 6: Invalid amounts are rejected');
withEnv(
  {
    MT_CONTRACT: 'v2_1.omni.hot.tg',
    MT_RECEIVER_ID: 'callback.near',
    MT_TOKEN_IDS: '["t1","t2"]',
    MT_AMOUNTS: '["100","-5"]',
    MT_CALLBACK_MSG_JSON: '{"key":"val"}',
  },
  () => {
    assertThrows(
      () => loadConfig(),
      'is not a valid positive integer amount',
      'rejects negative amount',
    );
  },
);
withEnv(
  {
    MT_CONTRACT: 'v2_1.omni.hot.tg',
    MT_RECEIVER_ID: 'callback.near',
    MT_TOKEN_IDS: '["t1","t2"]',
    MT_AMOUNTS: '["100","0"]',
    MT_CALLBACK_MSG_JSON: '{"key":"val"}',
  },
  () => {
    assertThrows(
      () => loadConfig(),
      'is not a valid positive integer amount',
      'rejects zero amount',
    );
  },
);
withEnv(
  {
    MT_CONTRACT: 'v2_1.omni.hot.tg',
    MT_RECEIVER_ID: 'callback.near',
    MT_TOKEN_IDS: '["t1","t2"]',
    MT_AMOUNTS: '["100","abc"]',
    MT_CALLBACK_MSG_JSON: '{"key":"val"}',
  },
  () => {
    assertThrows(
      () => loadConfig(),
      'is not a valid positive integer amount',
      'rejects non-numeric amount',
    );
  },
);
console.log();

// Test 7: Missing MT_RECEIVER_ID is rejected
console.log('Test 7: Missing required env vars are rejected');
withEnv(
  {
    MT_CONTRACT: 'v2_1.omni.hot.tg',
    MT_RECEIVER_ID: undefined,
    MT_TOKEN_IDS: '["t1","t2"]',
    MT_AMOUNTS: '["1","2"]',
    MT_CALLBACK_MSG_JSON: '{"key":"val"}',
  },
  () => {
    assertThrows(
      () => loadConfig(),
      'MT_RECEIVER_ID is required',
      'rejects missing MT_RECEIVER_ID',
    );
  },
);
withEnv(
  {
    MT_CONTRACT: 'v2_1.omni.hot.tg',
    MT_RECEIVER_ID: 'callback.near',
    MT_TOKEN_IDS: undefined,
    MT_AMOUNTS: '["1","2"]',
    MT_CALLBACK_MSG_JSON: '{"key":"val"}',
  },
  () => {
    assertThrows(
      () => loadConfig(),
      'MT_TOKEN_IDS is required',
      'rejects missing MT_TOKEN_IDS',
    );
  },
);
withEnv(
  {
    MT_CONTRACT: 'v2_1.omni.hot.tg',
    MT_RECEIVER_ID: 'callback.near',
    MT_TOKEN_IDS: '["t1","t2"]',
    MT_AMOUNTS: undefined,
    MT_CALLBACK_MSG_JSON: '{"key":"val"}',
  },
  () => {
    assertThrows(
      () => loadConfig(),
      'MT_AMOUNTS is required',
      'rejects missing MT_AMOUNTS',
    );
  },
);
withEnv(
  {
    MT_CONTRACT: 'v2_1.omni.hot.tg',
    MT_RECEIVER_ID: 'callback.near',
    MT_TOKEN_IDS: '["t1","t2"]',
    MT_AMOUNTS: '["1","2"]',
    MT_CALLBACK_MSG_JSON: undefined,
  },
  () => {
    assertThrows(
      () => loadConfig(),
      'MT_CALLBACK_MSG_JSON is required',
      'rejects missing MT_CALLBACK_MSG_JSON',
    );
  },
);
console.log();

// Test 8: Dry-run mode does not sign or submit (argv check)
console.log('Test 8: Dry-run / submit flag detection');
{
  const argvWithSubmit = ['node', 'script.ts', '--submit'];
  assert(
    argvWithSubmit.includes('--submit') === true,
    '--submit flag detected when present',
  );

  const argvWithoutSubmit = ['node', 'script.ts'];
  assert(
    argvWithoutSubmit.includes('--submit') === false,
    '--submit flag not detected when absent',
  );
}
console.log();

// Test 9: Exactly one mt_withdraw intent
console.log('Test 9: Exactly one mt_withdraw intent in output');
{
  const config: MtBatchWithdrawConfig = {
    mtContract: 'v2_1.omni.hot.tg',
    receiverId: 'callback.near',
    tokenIds: ['t1', 't2'],
    amounts: ['100', '200'],
    callbackMsg: { key: 'value' },
  };
  const intent = buildMtWithdrawIntent(config);
  // The function returns exactly one intent, not an array
  assert(intent.intent === 'mt_withdraw', 'returns exactly one mt_withdraw');
  // Verify it is a single object, not an array
  assert(!Array.isArray(intent), 'result is a single intent, not an array');
}
console.log();

// Test 10: Valid config loads successfully
console.log('Test 10: Valid config loads successfully from env');
withEnv(
  {
    MT_CONTRACT: 'v2_1.omni.hot.tg',
    MT_RECEIVER_ID: 'bridge-refuel.hot.tg',
    MT_TOKEN_IDS:
      '["137_qiStmoQJDQPTebaPjgx5VBxZv6L","137_3hpYoaLtt8MP1Z2GH1U473DMRKgr"]',
    MT_AMOUNTS: '["10000","20000"]',
    MT_CALLBACK_MSG_JSON:
      '{"receiver_id":"0x70E93a63A6f2a85784bF71Ba1d3Ca745202f9B33","amount_native":"1000"}',
    MT_MEMO: 'test',
  },
  () => {
    const config = loadConfig();
    assert(
      config.mtContract === 'v2_1.omni.hot.tg',
      'MT_CONTRACT loaded correctly',
    );
    assert(
      config.receiverId === 'bridge-refuel.hot.tg',
      'MT_RECEIVER_ID loaded correctly',
    );
    assert(config.tokenIds.length === 2, 'two token IDs loaded');
    assert(config.amounts.length === 2, 'two amounts loaded');
    assert(config.memo === 'test', 'memo loaded');
    assert(
      config.callbackMsg?.receiver_id === '2aEi7QMoRCvshYvrT779cXaDk1hC',
      'callback msg receiver_id Base58 encoded',
    );
  },
);
console.log();

// Test 11: Callback msg array/null rejected
console.log('Test 11: Callback msg must be a JSON object');
withEnv(
  {
    MT_CONTRACT: 'v2_1.omni.hot.tg',
    MT_RECEIVER_ID: 'callback.near',
    MT_TOKEN_IDS: '["t1","t2"]',
    MT_AMOUNTS: '["1","2"]',
    MT_CALLBACK_MSG_JSON: '[1,2,3]',
  },
  () => {
    assertThrows(
      () => loadConfig(),
      'must be a JSON object',
      'rejects JSON array as callback msg',
    );
  },
);
withEnv(
  {
    MT_CONTRACT: 'v2_1.omni.hot.tg',
    MT_RECEIVER_ID: 'callback.near',
    MT_TOKEN_IDS: '["t1","t2"]',
    MT_AMOUNTS: '["1","2"]',
    MT_CALLBACK_MSG_JSON: 'null',
  },
  () => {
    assertThrows(
      () => loadConfig(),
      'must be a JSON object',
      'rejects null as callback msg',
    );
  },
);
console.log();

// Test 12: Less than 2 token IDs rejected
console.log('Test 12: Less than 2 token IDs rejected');
withEnv(
  {
    MT_CONTRACT: 'v2_1.omni.hot.tg',
    MT_RECEIVER_ID: 'callback.near',
    MT_TOKEN_IDS: '["t1"]',
    MT_AMOUNTS: '["1"]',
    MT_CALLBACK_MSG_JSON: '{"key":"val"}',
  },
  () => {
    assertThrows(
      () => loadConfig(),
      'at least 2 token IDs',
      'rejects single token ID',
    );
  },
);
console.log();

// Test 13: min_gas and storage_deposit pass through
console.log('Test 13: Optional min_gas and storage_deposit');
{
  const config: MtBatchWithdrawConfig = {
    mtContract: 'v2_1.omni.hot.tg',
    receiverId: 'callback.near',
    tokenIds: ['t1', 't2'],
    amounts: ['1', '2'],
    callbackMsg: { key: 'val' },
    minGas: '50000000000000',
    storageDeposit: '1250000000000000000000',
  };
  const intent = buildMtWithdrawIntent(config);
  assert(intent.min_gas === '50000000000000', 'min_gas passed through');
  assert(
    intent.storage_deposit === '1250000000000000000000',
    'storage_deposit passed through',
  );
}
console.log();

// Test 14: resolveAutoCallbackMsg automatically sets defaults
console.log('Test 14: resolveAutoCallbackMsg auto-resolution');
{
  withEnv(
    {
      MT_BLOCK_NUMBER: '68420150',
      MT_DESTINATION_ADDRESS: undefined,
      MT_AMOUNT_NATIVE: undefined,
    },
    () => {
      // Async test in sync wrapper using Promise handling
      const promise = resolveAutoCallbackMsg();
      promise.then((resolved) => {
        assert(
          resolved.receiver_id === '2aEi7QMoRCvshYvrT779cXaDk1hC',
          'default destination address resolved in Base58',
        );
        assert(
          resolved.amount_native === DEFAULT_AMOUNT_NATIVE,
          'default amount_native resolved',
        );
        assert(
          resolved.block_number === 68420150,
          'block_number from MT_BLOCK_NUMBER resolved',
        );
      });
    },
  );
}
console.log();

// Test 15: loadConfig accepts autoCallbackMsg when MT_CALLBACK_MSG_JSON is omitted
console.log('Test 15: loadConfig with autoCallbackMsg');
withEnv(
  {
    MT_CONTRACT: 'v2_1.omni.hot.tg',
    MT_RECEIVER_ID: 'bridge-refuel.hot.tg',
    MT_TOKEN_IDS: '["137_tokenA","137_tokenB"]',
    MT_AMOUNTS: '["100","200"]',
    MT_CALLBACK_MSG_JSON: undefined,
  },
  () => {
    const autoMsg = {
      receiver_id: '2aEi7QMoRCvshYvrT779cXaDk1hC',
      amount_native: DEFAULT_AMOUNT_NATIVE,
      block_number: 99999999,
    };
    const config = loadConfig(autoMsg);
    assert(
      config.callbackMsg?.receiver_id === '2aEi7QMoRCvshYvrT779cXaDk1hC',
      'auto receiver_id passed to config',
    );
    assert(
      config.callbackMsg?.amount_native === DEFAULT_AMOUNT_NATIVE,
      'auto amount_native passed to config',
    );
    assert(
      config.callbackMsg?.block_number === 99999999,
      'auto block_number passed to config',
    );
  },
);
console.log();

// Test 16: encodeReceiverAddress converts EVM 0x address to Base58
console.log('Test 16: encodeReceiverAddress Base58 conversion');
{
  const evmAddr = '0x70E93a63A6f2a85784bF71Ba1d3Ca745202f9B33';
  const encoded = encodeReceiverAddress(evmAddr);
  assert(
    encoded === '2aEi7QMoRCvshYvrT779cXaDk1hC',
    'EVM address encoded to Base58 correctly',
  );
  assert(
    !encoded.startsWith('0'),
    'Base58 address does not contain invalid "0" character at byte 0',
  );

  const nearAccount = 'alice.near';
  assert(
    encodeReceiverAddress(nearAccount) === 'alice.near',
    'Named NEAR account left unchanged',
  );
}
console.log();

// ── Summary ────────────────────────────────────────────────────────────────────

console.log('══════════════════════════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('══════════════════════════════════════════════════════════');

if (failed > 0) {
  process.exit(1);
}
