# DSB lead notifications

This standalone CloudFormation stack handles DSB `call_analyzed` webhooks. It does
not deploy or change the shared `yapn-order-processor` Serverless stack.

## Flow

1. API Gateway preserves the request body. `receiver` uses the official Retell
   SDK to verify `x-retell-signature` against the exact raw body and the SSM
   `/yapn/retell-api-key` parameter (including timestamp/replay-window checks).
2. Only `call_analyzed` for `agent_0a42bdd38df7e9293ec1b7ba77` enters the encrypted
   SQS queue. Other authenticated events are acknowledged. Unanswered calls,
   voicemail, empty tests and agent-only greetings are skipped.
3. The worker reads `clientDatabase/BsdServices` consistently and checks its
   agent and `DSB_GROUP` ownership. It reads `leadsEmail` as an array, validates
   and deduplicates addresses, and snapshots the recipients and rendered email
   for that call. Later calls pick up recipient edits; retries retain the
   original plan. Empty/missing recipient arrays skip the call.
4. Separate messages are sent to each recipient through Resend using
   `/yapn/resend-api-key`, from `Yapn Leads <appointments@yapn.ai>`. Recipients are
   never exposed to one another. The email contains call time, caller ID,
   summary and the 20 configured extraction fields (excluding transfer reason).
   Undiscussed fields are omitted. It distinguishes estimate requests from
   confirmed appointments.

## Retry and duplicate protection

The worker has reserved concurrency **1** and the event-source batch size is
**1**. Individual sends are spaced 650 ms apart. Do not raise worker concurrency
without implementing a distributed per-recipient lease.

An encrypted, point-in-time-restorable DynamoDB ledger persists the call ID and
recipient completion state. Each provider request has a deterministic
call/recipient idempotency key. If a send succeeds but the ledger write fails,
the same body/key is retried. After all sends finish, the stored email and raw
recipient addresses are removed; the non-PII completion tombstone is retained
indefinitely to stop future webhook replays.

Resend keeps idempotency keys for 24 hours. An ambiguous send is **never retried
automatically after 23 hours**. Eight failed queue deliveries move the message
to the dead-letter queue; messages remain there for 14 days. An alarm uses the
existing Yapn alerts SNS topic when available. Review failures promptly. Before
manually replaying an old failed delivery, check Resend and the ledger to avoid
duplicate mail. Pending/failed jobs retain their recipient plan and message
until resolved; logs contain only controlled error codes, never full leads,
recipient addresses or secrets.

The provider may throttle this stack when other Yapn email traffic shares its
account; those failures are retried. Calls with large recipient lists resume
after the Lambda execution window using the saved per-recipient progress.

## Build, test, deploy

Requires Node 22+, Python 3 and AWS CLI with deploy access in `us-east-1`:

```sh
cd lead-notifications
npm ci
npm test
npm run build
python3 deploy.py
```

`deploy.py` runs tests/build, uploads a content-addressed ZIP to a private,
encrypted, versioned, dedicated artifact bucket, and deploys only
`yapn-dsb-lead-notifications`. The artifact bucket is managed by this script,
outside the stack, to preserve prior deployment packages. The delivery ledger
also has a retain policy. Review both explicitly during decommissioning.

The `WebhookUrl` stack output is the agent webhook. Retell configuration is
managed separately; subscribe to `call_analyzed`. This handler does not replace
the agent's inbound dynamic-variable webhook.

## Verification

`test/handler.test.js` exercises real Retell signatures, raw/base64 bodies,
event/agent gating, conversation filtering, private multi-recipient sends,
frozen recipient plans, dynamic recipients on later calls, invalid ownership,
empty/invalid recipients, HTML escaping, transient queue failures and ambiguous
provider-success retries. A 75-recipient fixture verifies no provider recipient
limit or recipient disclosure.

A provider-owned `delivered@resend.dev` sink was also used with injected test
client/ledger data and the real worker/SSM provider credential. An injected
ledger-write failure after the first successful send produced the same Resend
message ID on retry; a subsequent completed-call replay made no API request.
No synthetic customer email, historical reanalysis or phone call is needed.

References:
- [Retell webhook overview](https://docs.retellai.com/features/webhook-overview)
- [Resend idempotency keys](https://resend.com/changelog/idempotency-keys)
