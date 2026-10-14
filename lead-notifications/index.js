'use strict';

const { createHash } = require('node:crypto');
const Retell = require('retell-sdk');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');

const AGENT_ID = 'agent_0a42bdd38df7e9293ec1b7ba77';
const LOCATION_ID = 'BsdServices';
const GROUP_ID = 'DSB_GROUP';
const FIELDS = [
  ['customer_name', 'Customer name'], ['company_name', 'Company'],
  ['callback_number', 'Requested callback number'], ['customer_email', 'Customer email'],
  ['service_requested', 'Service requested'], ['property_type', 'Property type'],
  ['property_location', 'Property location'], ['property_size', 'Property size'],
  ['property_condition', 'Property condition'], ['specific_concerns', 'Specific concerns'],
  ['desired_timeframe', 'Desired timeframe'], ['service_frequency', 'Service frequency'],
  ['program_interest', 'Program interest'], ['estimate_status', 'Estimate status'],
  ['commercial_details', 'Commercial details'], ['construction_details', 'Construction details'],
  ['special_requirements', 'Special requirements'], ['customer_questions', 'Customer questions'],
  ['information_provided', 'Information provided'], ['next_steps', 'Next steps'],
];
const MAX_RETRY_WINDOW = 23 * 60 * 60 * 1000;
const hash = text => createHash('sha256').update(text).digest('hex');
const clean = (value, max = 5000) => typeof value === 'string'
  ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '';
const present = value => Boolean(value && !/^(not provided|not discussed|n\/?a|unknown|none)$/i.test(value));
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function normalizeRecipients(value) {
  if (!Array.isArray(value)) throw new Error('INVALID_LEADS_EMAIL_CONFIGURATION');
  const emails = [];
  for (const input of value) {
    if (typeof input !== 'string') throw new Error('INVALID_LEADS_EMAIL_CONFIGURATION');
    const email = input.trim().toLowerCase();
    if (!email || email.length > 254 || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(email)) {
      throw new Error('INVALID_LEADS_EMAIL_CONFIGURATION');
    }
    if (!emails.includes(email)) emails.push(email);
  }
  return emails;
}

function sanitizeCall(call) {
  const data = call.call_analysis?.custom_analysis_data || {};
  const values = Object.fromEntries(FIELDS.map(([key]) => [key, clean(data[key])]));
  // Ignore voicemail, unanswered attempts, agent-only greetings and empty web tests.
  const hasTranscript = Array.isArray(call.transcript_object) || typeof call.transcript === 'string';
  const userSpeech = Array.isArray(call.transcript_object)
    ? call.transcript_object.some(turn => turn.role === 'user' && clean(turn.content))
    : /(?:^|\n)\s*(?:user|customer|caller)\s*:/i.test(call.transcript || '');
  const hasConversation = hasTranscript ? Boolean(userSpeech) : Object.values(values).some(present);
  return {
    callId: call.call_id, from: clean(call.from_number, 80), to: clean(call.to_number, 80),
    direction: clean(call.direction, 30), callType: clean(call.call_type, 30),
    start: Number.isFinite(call.start_timestamp) ? call.start_timestamp : null,
    end: Number.isFinite(call.end_timestamp) ? call.end_timestamp : null,
    summary: clean(call.call_analysis?.call_summary, 10000), values,
    hasConversation: hasConversation && call.call_status !== 'not_connected' && call.call_analysis?.in_voicemail !== true,
  };
}

function formatEmail(call, client) {
  const timeZone = client.timeZone || 'America/New_York';
  let time = 'Not provided';
  if (call.start) {
    try { time = new Date(call.start).toLocaleString('en-US', { timeZone, dateStyle: 'full', timeStyle: 'long' }); }
    catch { time = new Date(call.start).toISOString(); }
  }
  const duration = call.start && call.end && call.end >= call.start
    ? `${Math.round((call.end - call.start) / 1000)} seconds` : 'Not provided';
  const details = FIELDS.map(([key, label]) => [label, call.values[key]]).filter(([, value]) => present(value));
  const title = clean(client.restaurantName, 100) || 'DSB Services Company';
  const name = present(call.values.customer_name) ? call.values.customer_name : call.from || 'Caller';
  const subject = `${title}: call follow-up — ${name}`.replace(/[\r\n]/g, ' ').slice(0, 200);
  const intro = 'Details extracted from a completed call. An estimate request or proposed time is not a confirmed appointment. Please review and follow up as needed.';
  const metadata = [['Call time', time], ['Duration', duration], ['Caller ID', call.from || 'Unavailable (web call or withheld)'],
    ['Yapn number', call.to || 'Not provided'], ['Call ID', call.callId]];
  const text = [title, intro, '', ...metadata.map(([label, value]) => `${label}: ${value}`), '',
    'Call summary', call.summary || 'Not provided', '', 'Captured details',
    ...details.map(([label, value]) => `${label}: ${value}`), '',
    'Fields not discussed during the call have been omitted.'].join('\n');
  const rows = [...metadata, ...details].map(([label, value]) => `<tr><th style="text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid #ddd">${escapeHtml(label)}</th><td style="padding:8px;border-bottom:1px solid #ddd;white-space:pre-wrap">${escapeHtml(value)}</td></tr>`).join('');
  return { from: 'Yapn Leads <appointments@yapn.ai>', subject, text,
    html: `<div style="font:15px/1.5 Arial,sans-serif;max-width:760px"><h2>${escapeHtml(title)} — Call follow-up</h2><p>${intro}</p><h3>Call summary</h3><p style="white-space:pre-wrap">${escapeHtml(call.summary || 'Not provided')}</p><table style="border-collapse:collapse;width:100%">${rows}</table><p>Fields not discussed during the call have been omitted.</p></div>` };
}

function createHandlers(deps) {
  const { db, sqs, secret, verify = Retell.verify, fetchImpl = fetch,
    pause = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now,
    queueUrl = process.env.QUEUE_URL, table = process.env.DELIVERY_TABLE } = deps;
  const response = (statusCode, status) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) });
  async function receiver(event) {
    try {
      const body = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
      if (Buffer.byteLength(body) > 1000000) return response(413, 'payload_too_large');
      const signature = Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === 'x-retell-signature')?.[1];
      if (!signature || !await verify(body, await secret('/yapn/retell-api-key'), signature)) return response(401, 'invalid_signature');
      let payload;
      try { payload = JSON.parse(body); } catch { return response(400, 'invalid_json'); }
      if (payload.event !== 'call_analyzed' || payload.call?.agent_id !== AGENT_ID) return response(200, 'ignored');
      if (!/^call_[A-Za-z0-9_-]{1,120}$/.test(payload.call.call_id || '')) return response(400, 'invalid_call_id');
      if (!payload.call.call_analysis || typeof payload.call.call_analysis !== 'object') return response(400, 'missing_analysis');
      const call = sanitizeCall(payload.call);
      if (!call.hasConversation) return response(200, 'no_conversation');
      await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(call) }));
      return response(200, 'queued');
    } catch {
      console.error('LEADS_WEBHOOK_PROCESSING_FAILED');
      return response(503, 'retry_later');
    }
  }

  async function processCall(call, context) {
    const id = `call_analyzed#${AGENT_ID}#${call.callId}`;
    let job = (await db.send(new GetCommand({ TableName: table, Key: { id }, ConsistentRead: true }))).Item;
    if (!job) {
      const client = (await db.send(new GetCommand({ TableName: 'clientDatabase', Key: { locationId: LOCATION_ID }, ConsistentRead: true }))).Item;
      if (!client || client.agentId !== AGENT_ID || client.groupId !== GROUP_ID) throw new Error('CLIENT_AGENT_MAPPING_MISMATCH');
      const recipients = normalizeRecipients(client.leadsEmail || []);
      job = { id, status: recipients.length ? 'PENDING' : 'SKIPPED_NO_RECIPIENTS', createdAt: now(),
        ...(recipients.length ? { recipients, sent: [], email: formatEmail(call, client), attempts: {} } : {}) };
      try {
        await db.send(new PutCommand({ TableName: table, Item: job, ConditionExpression: 'attribute_not_exists(id)' }));
      } catch (error) {
        if (error.name !== 'ConditionalCheckFailedException') throw error;
        job = (await db.send(new GetCommand({ TableName: table, Key: { id }, ConsistentRead: true }))).Item;
      }
    }
    if (job.status === 'SENT' || job.status === 'SKIPPED_NO_RECIPIENTS') return;
    for (const recipient of job.recipients) {
      const recipientHash = hash(recipient);
      if (job.sent.includes(recipientHash)) continue;
      // Freeze time of first send before calling the provider. Never risk replaying an
      // ambiguous send after Resend's 24h idempotency cache expires; leave it in DLQ.
      const startedAt = job.attempts[recipientHash] || now();
      if (now() - startedAt > MAX_RETRY_WINDOW) throw new Error('DELIVERY_REQUIRES_MANUAL_REVIEW');
      if (context?.getRemainingTimeInMillis?.() < 15000) throw new Error('CONTINUE_REMAINING_RECIPIENTS');
      if (!job.attempts[recipientHash]) {
        await db.send(new UpdateCommand({ TableName: table, Key: { id },
          UpdateExpression: 'SET attempts.#recipient = :time',
          ExpressionAttributeNames: { '#recipient': recipientHash }, ExpressionAttributeValues: { ':time': startedAt } }));
        job.attempts[recipientHash] = startedAt;
      }
      await pause(650); // Resend account default is two requests per second.
      const result = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${await secret('/yapn/resend-api-key')}`, 'content-type': 'application/json',
          'idempotency-key': `dsb-lead-${hash(id)}-${recipientHash}` },
        body: JSON.stringify({ ...job.email, to: [recipient] }),
      });
      if (!result.ok) throw new Error(`EMAIL_PROVIDER_STATUS_${result.status}`);
      const delivered = await result.json();
      if (typeof delivered.id !== 'string') throw new Error('EMAIL_PROVIDER_INVALID_RESPONSE');
      job.sent.push(recipientHash);
      await db.send(new UpdateCommand({ TableName: table, Key: { id },
        UpdateExpression: 'SET sent = :sent', ExpressionAttributeValues: { ':sent': job.sent } }));
    }
    // Keep the non-PII tombstone indefinitely, remove the stored email/addresses.
    await db.send(new UpdateCommand({ TableName: table, Key: { id },
      UpdateExpression: 'SET #status = :sent, completedAt = :now REMOVE email, recipients, attempts',
      ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':sent': 'SENT', ':now': now() } }));
  }

  async function worker(event, context) {
    const batchItemFailures = [];
    for (const record of event.Records || []) {
      try { await processCall(JSON.parse(record.body), context); }
      catch (error) {
        // Error messages are controlled codes; never log payloads, recipient addresses or provider responses.
        console.error('LEADS_DELIVERY_FAILED', /^[A-Z_]+(?:\d+)?$/.test(error.message) ? error.message : 'DEPENDENCY_ERROR');
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  }
  return { receiver, worker };
}

let production;
function handlers() {
  if (!production) {
    const ssm = new SSMClient({});
    const cache = new Map();
    production = createHandlers({
      db: DynamoDBDocumentClient.from(new DynamoDBClient({})), sqs: new SQSClient({}),
      secret: async name => {
        const cached = cache.get(name);
        if (cached && Date.now() - cached.time < 300000) return cached.value;
        const value = (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))).Parameter.Value;
        cache.set(name, { value, time: Date.now() });
        return value;
      },
    });
  }
  return production;
}
exports.receiver = event => handlers().receiver(event);
exports.worker = (event, context) => handlers().worker(event, context);
exports.createHandlers = createHandlers;
exports.sanitizeCall = sanitizeCall;
exports.formatEmail = formatEmail;
exports.normalizeRecipients = normalizeRecipients;
