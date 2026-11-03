# case: amount_native= 100000000000000000

{
"ActionError": {
"kind": {
"FunctionCallError": {
"ExecutionError": "Smart contract panicked: panicked at src/lib.rs:112:56:\nAmount overflow"
}
},
"index": 0
}
}

# case: amount_native=999999999999999999999999999999999999999999999999999999999999999999

{
"ActionError": {
"kind": {
"FunctionCallError": {
"ExecutionError": "Smart contract panicked: panicked at src/lib.rs:101:86:\ncalled `Result::unwrap()` on an `Err` value: Error(\"number too large to fit in target type\", line: 1, column: 130)"
}
},
"index": 0
}
}

# case: receiver_id: 0x70e93a63a6f2a85784bf71ba1d3ca745202f9B33 (all lowercase)

https://nearblocks.io/txns/2oPJJ9rfZaUi6CP8Tmu1Epxd4QJSRF2mu3jwENaJdkuS/enhanced

# case: block_number=0

https://nearblocks.io/txns/Ab9q5UtpJQiwmtT9Q8yAZuL4af9cM92CVhGFckHXq7pp/enhanced
{
"ActionError": {
"kind": {
"FunctionCallError": {
"ExecutionError": "Smart contract panicked: panicked at src/lib.rs:112:56:\nAmount overflow"
}
},
"index": 0
}
}

# case: second token added with small amount

https://nearblocks.io/txns/MDgrEA5X3gdBW5yM8zCuktZcKqYyDN5Q4jHodbGhm2m/enhanced

- the second token is used as gas fee
