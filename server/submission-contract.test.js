const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const browser=fs.readFileSync(path.join(__dirname,'../client/exam.html'),'utf8');
const audio=fs.readFileSync(path.join(__dirname,'../client/speaking-audio.js'),'utf8');
const server=fs.readFileSync(path.join(__dirname,'server.js'),'utf8');
const scoring=require('./speaking-scoring');
test('recorded audio is persisted before question navigation',()=>{
 const stop=browser.slice(browser.indexOf('mediaRecorder.onstop = async'),browser.indexOf('mediaRecorder.onstop = async')+2300);
 assert.match(stop,/reader\.readAsDataURL\(originalAudioBlob\)/);
 assert.match(stop,/speakingAudioBase64 = reader\.result/);
 assert.match(stop,/saveCurrentAnswer\(/);
});
test('final submission converts browser recordings before sending them',()=>{
 assert.match(browser,/PteSpeakingAudio\.prepareAnswers\(examData\.answers\)\.then\(/);
 assert.match(browser,/JSON\.stringify\(\{\.\.\.examData,answers:preparedAnswers\}\)/);
 assert.match(audio,/async function toAssessmentWav\(/);
 assert.match(audio,/async function prepareAnswers\(/);
});
test('unsupported recordings are not silently treated as successfully assessed',()=>{
 assert.throws(()=>scoring.getInputAudio('data:audio/webm;base64,AAAA'),/WAV or MP3/);
 assert.throws(()=>scoring.getInputAudio('data:audio/mp4;base64,AAAA'),/WAV or MP3/);
});
test('server uses assigned question snapshot, not user-supplied question scores',()=>{
 const handler=server.slice(server.indexOf('app.post("/save-exam"'),server.indexOf('function normalizeResultRow('));
 assert.match(handler,/assignedExam\.questions\.map\(q =>/);
 assert.match(handler,/questionId: q\.id, type: q\.type, subType: q\.subType/);
 assert.match(handler,/enrichAnswersWithScores\(completeAnswers, assignedExam\.questions\)/);
 assert.match(handler,/\.eq\("exam_code", examCode\)/);
});
test('page exit marks interruption and attempts best-effort submission',()=>{
 assert.match(browser,/function submitDepartingExam\(/);
 assert.match(browser,/localStorage\.setItem\("examInterrupted", "true"\)/);
 assert.match(browser,/navigator\.sendBeacon\("\/save-exam"/);
 assert.match(browser,/if \(localStorage\.getItem\("examInterrupted"\) === "true" \|\| isExamSessionExpired\(\)\)/);
});
