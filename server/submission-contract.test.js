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
 assert.match(browser,/navigator\.sendBeacon\("\/fail-exam"/);
 assert.match(browser,/if \(localStorage\.getItem\("examInterrupted"\) === "true" \|\| isExamSessionExpired\(\)\)/);
});

test('repeated submission checks existing result before rescoring',()=>{
 const handler=server.slice(server.indexOf('app.post("/save-exam"'),server.indexOf('function normalizeResultRow('));
 const check=handler.indexOf('.from("exam_results")');
 const score=handler.indexOf('await enrichAnswersWithScores(');
 assert.ok(check>=0&&score>check);
 assert.match(handler,/existingResult\.length > 0/);
 assert.match(handler,/alreadySaved: true/);
});
test('database unique-key collision returns already saved without duplicate result',()=>{
 const handler=server.slice(server.indexOf('app.post("/save-exam"'),server.indexOf('function normalizeResultRow('));
 assert.match(handler,/error\.code === "23505"/);
 assert.match(handler,/DUPLICATE EXAM BLOCKED/);
});
test('submission failure keeps local answers and enables retry',()=>{
 const finish=browser.slice(browser.indexOf('function finishExam('),browser.indexOf('function finishExam(')+3900);
 assert.match(finish,/\.catch\(error =>/);
 assert.match(finish,/examSubmissionInProgress = false/);
 assert.match(finish,/finishButton\.disabled = false/);
 assert.match(finish,/Your saved responses are still on this device/);
 const clear=finish.indexOf('localStorage.clear()');
 const success=finish.indexOf('.then((data) =>');
 assert.ok(clear>success,'Local answers should only be cleared after successful save');
});
test('server rejects unknown exam code and reconstructs assigned answers',()=>{
 const handler=server.slice(server.indexOf('app.post("/save-exam"'),server.indexOf('function normalizeResultRow('));
 assert.match(handler,/Exam code is required/);
 assert.match(handler,/Assigned exam could not be found/);
 assert.match(handler,/assignedExam\.questions\.map\(q =>/);
});

test('interrupted attempts are recorded as failed',()=>{const h=server.slice(server.indexOf('app.post("/fail-exam"'),server.indexOf('app.post("/save-exam"'));assert.match(h,/status:"failed"/);assert.match(h,/answers:\[\]/);});

test('expired exams are marked failed without scoring saved answers',()=>{const expire=browser.slice(browser.indexOf('function expireExamSession()'),browser.indexOf('function touchExamSession()'));assert.match(expire,/submitDepartingExam\(\)/);assert.doesNotMatch(expire,/finishExam\(/);});
test('admin displays failure state instead of a numeric score',()=>{const admin=fs.readFileSync(path.join(__dirname,'../client/admin.html'),'utf8');assert.match(admin,/exam\.summary\?\.status === "failed"/);assert.match(admin,/Sınav başarısız/);});

test('failed exam reporting retries through fetch when the page is visible',()=>{
 const handler=browser.slice(browser.indexOf('function submitDepartingExam()'),browser.indexOf('window.addEventListener("pagehide"'));
 assert.match(handler,/document\.hidden/);
 assert.match(handler,/fetch\("\/fail-exam"/);
 assert.match(handler,/keepalive: true/);
 assert.match(handler,/navigator\.sendBeacon\("\/fail-exam"/);
});
test('failed exam records normalize international phone digits',()=>{
 const handler=server.slice(server.indexOf('app.post("/fail-exam"'),server.indexOf('app.post("/save-exam"'));
 assert.ok(handler.includes('replace(/\\D/g,"")'));
 assert.ok(!handler.includes('replace(/\\\\D/g,"")'));
});

test('failure reporting does not send answer data',()=>{
 const handler=browser.slice(browser.indexOf('function submitDepartingExam()'),browser.indexOf('window.addEventListener("pagehide"'));
 assert.doesNotMatch(handler,/examAnswers|speakingAudio|preparedAnswers/);
 assert.match(handler,/JSON\.stringify\(payload\)/);
});
test('failure status is not overwritten by a second failure notification',()=>{
 const handler=server.slice(server.indexOf('app.post("/fail-exam"'),server.indexOf('app.post("/save-exam"'));
 assert.match(handler,/existing\?\.length/);
 assert.match(handler,/alreadySaved:true/);
 assert.match(handler,/error\.code==="23505"/);
});

test('existing failed attempt is not shown as a completed exam',()=>{
 const handler=server.slice(server.indexOf('app.post("/save-exam"'),server.indexOf('function normalizeResultRow('));
 assert.match(handler,/\.select\("id,summary"\)/);
 assert.match(handler,/existingResult\[0\]\?\.summary\?\.status === "failed"/);
 const finish=browser.slice(browser.indexOf('function finishExam('),browser.indexOf('function finishExam(')+4400);
 assert.match(finish,/data\.status === "failed"/);
 assert.ok(finish.indexOf('data.status === "failed"')<finish.indexOf('localStorage.clear()'));
});
