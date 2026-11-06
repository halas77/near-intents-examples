here is my knowledge for this happy path:

near intent -> v2_1.omni.hot.tg -> bridge-refuel.hot.tg -> v2_1.omni.hot.tg -> near intent

- the protocol have to flow simulation(dry run, read only flow, validation) and execution stages separately.

- simulation and execution use similar functions.

- every large amount that are greater than the user balance will be reverted in the first validation in simulation stage.

- the simulation stage will catch any invalid things before the execution stage, ensuring that only valid transactions are executed.

- the execution stage will only proceed if the simulation stage passes without any errors.

- just one token is bridged at a time, even if it takes an array of token IDs and amounts, But the other tokens(beside the first position token) in the array are just directly given to the receiver(bridge-refuel.hot.tg).

- zero amount are not allowed in the bridging process.

- you can even dd more than two tokens like [token1, token2, token3], but only the first token will be bridged, and the rest will be directly given to the receiver(bridge-refuel.hot.tg).

- even in same tokens in the array, only the first token will be bridged, and the rest will be directly given to the receiver(bridge-refuel.hot.tg).

- I sent three tokens [token1, token2, token3], but only the first token will be bridged, and the rest will be directly given to the receiver(bridge-refuel.hot.tg) and in on_withdraw_complete only the second token balance, the first token chian id and blocknumber and the second token account id will be available.

- and all amount s are credited with the exact amount to the bridged account or to the receiver(bridge-refuel.hot.tg). (no fees or deductions are applied).

- if i send just one token, it will be bridged as expected, and the receiver(bridge-refuel.hot.tg) will not receive any additional tokens but in on_withdraw_complete only the zero amount for the first token will be appeared with block number and chain id.

- the bridging process succeeds with min_gas set to 0, but max gas set to be MT_MIN_GAS=100000000000000, greater values fails with

for this 1000000000000000000010000000000000000000 -> 'error simulating intents: wasm execution failed with error: HostError(GuestPanic { panic_msg: "JSON: number too large to fit in target type at line 1 column 437" })',

for this: details:10000000000000000000
'Intent is published but not settled.',
metaMessages: [
'Status: NOT_FOUND_OR_NOT_VALID',
'Intent hash: 6AgtAdg8ZJbt5dUXEzrEurZfYJ2gu5mEh6y4DVf8uyjb',
'Tx hash: BKX3aCnQcrK28aSGYM2qrsFqpg3hsXAVfoNdn2pAYQ36'
],

-

Notes:

- nested amount_native succeed
- any block number succeed
- amount_native=0 succeed
- unknown key succeed
- multiple unknown keys succeed
- duplicate unknown keys accept only the last
- missing amount_native panics with "Smart contract panicked: panicked at src/lib.rs:111:65:
  called `Option::unwrap()` on a `None` value"
- any account_id succeed
- wrong type for amount_native panics with "Smart contract panicked: panicked at src/lib.rs:101:86:
  called `Result::unwrap()` on an `Err` value: Error("invalid type: integer `0`, expected a string", line: 1, column: 18)
- random(i just change valid base58 and randomly change some chars) receiver_id succeed

Notes:

- amount_native=null panics with "Smart contract panicked: panicked at src/lib.rs:111:65:
  called `Option::unwrap()` on a `None` value"
- amount_native non-numeric panics with "Smart contract panicked: panicked at src/lib.rs:101:86:
  called `Result::unwrap()` on an `Err` value: Error("invalid digit found in string", line: 1, column: 22)"
- receiver_id missing panics with "Smart contract panicked: panicked at src/lib.rs:101:86:
  called `Result::unwrap()` on an `Err` value: Error("missing field `receiver_id`", line: 1, column: 41)"
- string block_number panics with "Smart contract panicked: panicked at src/lib.rs:101:86:
  called `Result::unwrap()` on an `Err` value: Error("invalid type: string \"100\", expected u64", line: 1, column: 88)"
- maximum u128 native_amount panics with "Smart contract panicked: panicked at src/lib.rs:112:56:
  Amount overflow"

Notes:

- it accepts large receiver_id values like: "2aEi7QMoRCvshYvrT779cXaDk1ha2aEi7QMoRCvshYvrT779cXaDk1ha2aEi7QMoRCvshYvrT779cXaDk1ha2aEi7QMoRCvshYvrT779cXaDk1ha2aEi7QMoRCvshYvrT779cXaDk1ha2aEi7QMoRCvshYvrT779cXaDk1ha2aEi7QMoRCvshYvrT779cXaDk1ha2aEi7QMoRCvshYvrT779cXaDk1ha2aEi7QMoRCvshYvrT779cXaDk1ha2aEi7QMoRCvshYvrT779cXaDk1ha2aEi7QMoRCvshYvrT779cXaDk1ha2aEi7QMoRCvshYvrT779cXaDk1ha2aEi7QMoRCvshYvrT779cXaDk1ha2aEi7QMoRCvshYvrT779cXaDk1ha2aEi7QMoRCvshYvrT779cXaDk1ha2aEi7QMoRCvshYvrT779cXaDk1ha"

- when i try receiver_id with extremely large value, it panics with Exceeded the prepaid gas. the tnx is the attacked

Notes:

Campaign 1:

- MT_AMOUNTS vs msg.amount_native:
  - lets say MT_AMOUNTS = ["2000"] and msg.amount_native = "0", the result is 2000 token is bridged
  - lets say MT_AMOUNTS = ["2000"] and msg.amount_native = "1", the result is 1999 tokens are bridged and 1 token is transferred to the receiver.
  - lets say MT_AMOUNTS = ["2000"] and msg.amount_native = "1999", the result is 1 token is bridges and 1999 tokens transferred to the receiver.
  - lets say MT_AMOUNTS = ["2000"] and msg.amount_native = "2000", the result is 2000 tokens are transferred to the receiver and none is bridged.
  - lets say MT_AMOUNTS = ["2000"] and msg.amount_native = "2001", panics with Smart contract panicked: panicked at src/lib.rs:112:56: Amount overflow
  * in every case mt_on_transfer returns 0 and the resolver returns 2000.

Campaign 2:

- MT_MIN_GAS pass successfully in every case below around 1000000000000000(i dont gent the exact number).

- the transaction fails when MT_MIN_GAS is set above 1000000000000000.
  details: 'Intent is published but not settled.',
  metaMessages: [
  'Status: NOT_FOUND_OR_NOT_VALID',
  'Intent hash: CcNUHyE3cXWmb9mwC8Q4huHHLaNzESxeHhSDCfkCQQMY',
  'Tx hash: 6QE8L5BD7B7U49SB7coxbHyApqieBv7N3kC4dRzz5ZeG'
  ],
  shortMessage: 'Intent settlement failed.',
  result: {
  intent_hash: 'CcNUHyE3cXWmb9mwC8Q4huHHLaNzESxeHhSDCfkCQQMY',
  status: 'NOT_FOUND_OR_NOT_VALID',
  status_details: 'FAILED',
  data: { hash: '6QE8L5BD7B7U49SB7coxbHyApqieBv7N3kC4dRzz5ZeG' }
  }

Campaign 3:

- receiver_id fails with length above 704. Below and equal to 704, it passes successfully.
- but for all the mt_on_transfer return 0 and resolver returns the original MT_AMOUNTS. even in failed transactions.

- 880 is the maximum length to work.

when i add white space in the receiver_id it panics wth "Smart contract panicked: panicked at src/lib.rs:101:86: called `Result::unwrap()` on an `Err` value: Error("control character (\\u0000-\\u001F) found while parsing a string", line: 2, column: 0)"

Campaign 4:

- same receiver_id - panics with "Smart contract panicked: panicked at src/lib.rs:101:86:
  called `Result::unwrap()` on an `Err` value: Error("duplicate field `receiver_id`", line: 1, column: 81)"

- same amount_native - panics with "Smart contract panicked: panicked at src/lib.rs:101:86:
  called `Result::unwrap()` on an `Err` value: Error("duplicate field `amount_native`", line: 1, column: 37)"

- same block_number - panics with "Smart contract panicked: panicked at src/lib.rs:101:86:
  called `Result::unwrap()` on an `Err` value: Error("duplicate field `block_number`", line: 1, column: 103)"

Campaign 5:

- add another keys passes and the tokens are bridged successfully. no strange things happen.

In my conclusion for the above campaigns: the whole refund behavior are in mt_on_transfer so fully focus on that which can be situations that leads to silent failure then refund but still goes to withdraw process
