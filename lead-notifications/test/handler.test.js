'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Retell = require('retell-sdk');
const { createHandlers, sanitizeCall, normalizeRecipients } = require('../index');
const { sign } = require('retell-sdk/lib/webhook_auth');
const agentId = 'agent_0a42bdd38df7e9293ec1b7ba77';
const call = () => ({ call_id: 'call_test_123', agent_id: agentId, from_number: '+12025550123',
  to_number: '+15714706463', start_timestamp: 1791990000000, end_timestamp: 1791990060000,
  transcript_object: [{role:'user',content:'I need carpet cleaning'}],
  call_analysis: {call_summary:'Carpet cleaning request', custom_analysis_data:{customer_name:'Test <Customer>',service_requested:'Carpet cleaning',estimate_status:'Requested; not booked'}} });

function fixture(options = {}) {
  let client = {locationId:'BsdServices',groupId:'DSB_GROUP',agentId,restaurantName:'DSB Services Company',timeZone:'America/New_York',leadsEmail:['one@example.com','two@example.com']};
  const jobs = new Map(), sent = [], queue = [], provider = new Map();
  let failMark = false, clock = Date.now();
  const db = {send: async cmd => {
    const i = cmd.input;
    if (cmd.constructor.name === 'GetCommand') return {Item:structuredClone(i.TableName === 'clientDatabase' ? client : jobs.get(i.Key.id))};
    if (cmd.constructor.name === 'PutCommand') {
      if(jobs.has(i.Item.id)) throw Object.assign(new Error(),{name:'ConditionalCheckFailedException'});
      jobs.set(i.Item.id,structuredClone(i.Item)); return {};
    }
    const j=jobs.get(i.Key.id),v=i.ExpressionAttributeValues;
    if(i.UpdateExpression.startsWith('SET attempts.')) j.attempts[i.ExpressionAttributeNames['#recipient']]=v[':time'];
    else if(i.UpdateExpression==='SET sent = :sent') {if(failMark){failMark=false;throw new Error('INJECTED_WRITE_FAILURE')} j.sent=structuredClone(v[':sent'])}
    else {j.status=v[':sent']; j.completedAt=v[':now'];delete j.email;delete j.recipients;delete j.attempts}
    return {};
  }};
  const fetchImpl = async (url, init) => {
    const body=JSON.parse(init.body),key=init.headers['idempotency-key'];
    if(provider.has(key)) assert.deepEqual(body,provider.get(key).body);
    else {provider.set(key,{body}); sent.push(body)}
    return {ok:true,json:async()=>({id:'email_sink'})};
  };
  const handlers=createHandlers({db,sqs:{send:async cmd=>queue.push(cmd.input)},secret:async()=> 'test-key',
    fetchImpl,pause:async()=>{},now:()=>clock,table:'test-deliveries',queueUrl:'queue',...options});
  return {...handlers,jobs,sent,queue, setClient:v=>{client=v},getClient:()=>client,
    failNextMark:()=>{failMark=true},advance:ms=>{clock+=ms},
    run:async c=>handlers.worker({Records:[{messageId:'message_test',body:JSON.stringify(sanitizeCall(c || call()))}]} )};
}

test('Retell SDK verifies exact raw body, rejects tampering, missing/stale signatures and accepts base64', async()=>{
  const f=fixture(); const body=JSON.stringify({event:'call_analyzed',call:call()},null,2);
  const signature=await sign(body,'test-key');
  assert.equal((await f.receiver({body,headers:{'X-Retell-Signature':signature}})).statusCode,200);
  assert.equal(f.queue.length,1);
  assert.equal((await f.receiver({body:JSON.stringify(JSON.parse(body)),headers:{'x-retell-signature':signature}})).statusCode,401);
  assert.equal((await f.receiver({body,headers:{}})).statusCode,401);
  const stale=await require('retell-sdk/lib/webhook_auth').symmetric.sign(body,'test-key',Date.now()-600000);
  assert.equal(await Retell.verify(body,'test-key',stale),false);
  assert.equal((await f.receiver({body:Buffer.from(body).toString('base64'),isBase64Encoded:true,headers:{'x-retell-signature':signature}})).statusCode,200);
});
test('acknowledges irrelevant events, wrong agents, empty calls and voicemail without queueing', async()=>{
  const f=fixture({verify:async()=>true});
  for(const payload of [{event:'call_ended',call:call()}, {event:'call_analyzed',call:{...call(),agent_id:'agent_other'}},
    {event:'call_analyzed',call:{...call(),transcript_object:[],call_analysis:{custom_analysis_data:{customer_name:'Not provided'}}}},
    {event:'call_analyzed',call:{...call(),call_analysis:{...call().call_analysis,in_voicemail:true}}},
    {event:'call_analyzed',call:{...call(),call_status:'not_connected'}},
    {event:'call_analyzed',call:{...call(),transcript_object:[{role:'agent',content:'Thanks for calling'}],call_analysis:{custom_analysis_data:{information_provided:'Agent introduced DSB'}}}}]) {
    assert.equal((await f.receiver({body:JSON.stringify(payload),headers:{'x-retell-signature':'test'}})).statusCode,200);
  }
  assert.equal(f.queue.length,0);
});
test('sends one private email per deduplicated recipient and never resends a completed call',async()=>{
  const f=fixture();f.getClient().leadsEmail=['ONE@example.com','one@example.com','two@example.com'];
  assert.deepEqual(await f.run(),{batchItemFailures:[]}); assert.equal(f.sent.length,2);
  assert.deepEqual(f.sent[0].to,['one@example.com']);assert.deepEqual(f.sent[1].to,['two@example.com']);
  assert.ok(f.sent[0].html.includes('Test &lt;Customer&gt;'));assert.ok(!f.sent[0].html.includes('transfer_reason'));
  assert.ok(f.sent[0].text.includes('not a confirmed appointment'));
  assert.deepEqual(await f.run(),{batchItemFailures:[]});assert.equal(f.sent.length,2);
  const job=[...f.jobs.values()][0];assert.equal(job.status,'SENT');assert.equal(job.email,undefined);assert.equal(job.recipients,undefined);
});
test('ambiguous provider success retries the same frozen body/key and avoids duplicate delivery',async()=>{
  const f=fixture();f.failNextMark();
  assert.equal((await f.run()).batchItemFailures.length,1);assert.equal(f.sent.length,1);
  f.getClient().leadsEmail=['changed@example.com'];
  assert.deepEqual(await f.run(),{batchItemFailures:[]});assert.equal(f.sent.length,2);
  assert.deepEqual(f.sent.map(m=>m.to[0]),['one@example.com','two@example.com']);
});
test('later calls look up fresh recipients; empty configuration skips, invalid config fails',async()=>{
  const f=fixture();await f.run();f.getClient().leadsEmail=['changed@example.com'];await f.run({...call(),call_id:'call_second'});
  assert.equal(f.sent[2].to[0],'changed@example.com');
  f.getClient().leadsEmail=[];await f.run({...call(),call_id:'call_empty'});assert.equal(f.sent.length,3);
  f.getClient().leadsEmail='not-an-array';assert.equal((await f.run({...call(),call_id:'call_invalid'})).batchItemFailures.length,1);
});
test('agent/group mismatch prevents sending to a different client',async()=>{
  const f=fixture();f.getClient().agentId='agent_other';assert.equal((await f.run()).batchItemFailures.length,1);assert.equal(f.sent.length,0);
});
test('refuses ambiguous retries outside the provider idempotency window',async()=>{
  const f=fixture();f.failNextMark();await f.run();f.advance(24*60*60*1000);
  assert.equal((await f.run()).batchItemFailures.length,1);assert.equal(f.sent.length,1);
});
test('supports more recipients than the provider per-email limit without exposing them',async()=>{
  const f=fixture();f.getClient().leadsEmail=Array.from({length:75},(_,i)=>`recipient${i}@example.com`);
  assert.deepEqual(await f.run(),{batchItemFailures:[]});assert.equal(f.sent.length,75);
  for(const email of f.sent) assert.equal(email.to.length,1);
});
test('rejects malformed recipients instead of sending partially or injecting headers',()=>{
  for(const value of ['a@example.com',['bad'],['ok@example.com','bad'],['a@example.com\r\nbcc:bad@example.com']]) assert.throws(()=>normalizeRecipients(value));
});
test('queue failure returns retryable webhook failure and sends no email inline',async()=>{
  const f=fixture({verify:async()=>true,sqs:{send:async()=>{throw new Error('FAIL')}}});
  assert.equal((await f.receiver({body:JSON.stringify({event:'call_analyzed',call:call()}),headers:{'x-retell-signature':'x'}})).statusCode,503);
  assert.equal(f.sent.length,0);
});
