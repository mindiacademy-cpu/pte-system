const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {getInputAudio,parseAssessment,assessSpeakingAudio} = require('./speaking-scoring');
const {encodeMonoWav} = require('../client/speaking-audio');
const {prepareAnswers} = require('../client/speaking-audio');
const pcm = Buffer.from(encodeMonoWav(new Float32Array([0,-1,1,0.25]),16000));
const recording = 'data:audio/wav;base64,' + pcm.toString('base64');
const response = overrides => JSON.stringify({speechDetected:true,transcript:'The cat sat.',content:4,pronunciation:3,oralFluency:2,feedback:'Duraksamalar var.',...overrides});

test('browser WAV is valid mono PCM16; actual samples and sample rate retained', () => {
  assert.equal(pcm.toString('ascii',0,4),'RIFF');
  assert.equal(pcm.readUInt32LE(24),16000);
  assert.equal(pcm.readUInt16LE(22),1);
  assert.equal(pcm.readInt16LE(46),-32768);
  assert.equal(pcm.readInt16LE(48),32767);
  assert.equal(getInputAudio(recording).format,'wav');
});
test('reject malformed and unsupported recordings without claiming assessment', () => {
  assert.throws(()=>getInputAudio('data:audio/webm;base64,abcd'));
  assert.throws(()=>getInputAudio('data:audio/wav;base64,'+Buffer.alloc(100).toString('base64')));
});
test('audio traits contribute to score; content zero and silence cannot earn points', () => {
  assert.equal(parseAssessment(response(),15).score,9);
  assert.equal(parseAssessment(response({content:0,pronunciation:5,oralFluency:5}),15).score,0);
  assert.equal(parseAssessment(response({speechDetected:false}),15).score,0);
  assert.throws(()=>parseAssessment(response({pronunciation:'5'}),15));
  assert.throws(()=>parseAssessment(response({oralFluency:8}),15));
});
test('short answers assess only content and mark audio traits not assessed', () => {
  const result = parseAssessment(response({content:5}),1,true);
  assert.equal(result.score,1);
  assert.equal(result.pronunciation,null);
  assert.equal(result.oralFluency,null);
});
test('API receives actual audio and source; results use audio transcript', async () => {
  let sent;
  const openai = {chat:{completions:{create:async args=>{
    sent=args; return {choices:[{message:{content:response()}}]};
  }}}};
  const result = await assessSpeakingAudio({openai,question:{subType:'read_aloud',prompt:'Read aloud'},recording,maxScore:5,reference:'The cat sat.'});
  assert.equal(sent.modalities[0],'text');
  assert.equal(sent.messages[1].content[1].input_audio.data,pcm.toString('base64'));
  assert.match(sent.messages[1].content[0].text,/The cat sat/);
  assert.equal(result.score,3);
  assert.equal(result.assessmentMethod,'audio');
  assert.equal(result.manualReviewRequired,false);
});

test('submission preparation does not mutate compact saved answers', async () => {
  const original = [{type:'speaking',speakingAudio:recording},{type:'writing',answer:'test'}];
  const copy = JSON.stringify(original);
  const result = await prepareAnswers(original);
  assert.equal(JSON.stringify(original),copy);
  assert.equal(result.length,2);
});

test('audio service failure is explicitly provisional, never invented pronunciation', async () => {
  const source = fs.readFileSync(__dirname+'/server.js','utf8');
  const wrapper = source.slice(source.indexOf('async function scoreSpeakingWithAI('),source.indexOf('async function transcribeAudioFromUrl('));
  const context = vm.createContext({console:{error(){}},getSpeakingReference:async()=> 'source',
    assessSpeakingAudio:async()=>{throw Error('API unavailable');},
    scoreSpeakingContentWithAI:async()=>({score:3,content:3,pronunciation:null,oralFluency:null})});
  vm.runInContext(wrapper,context);
  const result = await vm.runInContext('scoreSpeakingWithAI({question:{},transcript:"words",maxScore:5,recording:"audio"})',context);
  assert.equal(result.manualReviewRequired,true);
  assert.equal(result.assessmentMethod,'transcript-only');
  assert.equal(result.pronunciation,null);
  assert.equal(result.oralFluency,null);
});
