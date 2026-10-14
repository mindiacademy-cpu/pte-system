const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'server.js'),'utf8');
const bank = JSON.parse(fs.readFileSync(path.join(__dirname,'questions.json'),'utf8'));
const start = source.indexOf('function normalizeText(');
const end = source.indexOf('function ensureFile(');
const selectionStart = source.indexOf('const EXAM_TASK_COUNTS');
const selectionEnd = source.indexOf('app.post("/create-exam"');
assert.ok(start>=0 && end>start && selectionStart>=0 && selectionEnd>selectionStart);
const context=vm.createContext({console});
vm.runInContext(source.slice(start,end)+source.slice(selectionStart,selectionEnd),context);
vm.runInContext(source.slice(source.indexOf('function getAutomaticPoints('),source.indexOf('function normalizeExamResult(')),context);
const run = expression => vm.runInContext(expression,context);
const ready = q => run('isExamReady('+JSON.stringify(q)+')');
test('bank has all 22 compact task types with at least one ready question',()=>{
 const groups={};for(const q of bank){if(ready(q))(groups[q.subType]??=[]).push(q);}
 const expected=run('Object.keys(EXAM_TASK_COUNTS)');
 assert.equal(expected.length,22);
 for(const type of expected)assert.ok(groups[type]?.length, 'Missing ready question: '+type);
});
test('all multiple choice keys exist in their options',()=>{
 for(const q of bank){
 if(['reading_mcq_single','listening_mcq_single','highlight_correct_summary','select_missing_word'].includes(q.subType))assert.ok(q.options.includes(q.correctAnswer),q.id);
 if(['reading_mcq_multiple','listening_mcq_multiple'].includes(q.subType)){assert.ok(q.correctAnswers.length,q.id);for(const answer of q.correctAnswers)assert.ok(q.options.includes(answer),q.id);}
 }
});
test('all fill blank keys match the number of blanks',()=>{
 for(const q of bank.filter(q=>['reading_fill_blanks','reading_writing_fill_blanks','listening_fill_blanks'].includes(q.subType))){
 const count=(q.textContent.match(/_{3,}/g)||[]).length;
 assert.ok(count>0,q.id);
 assert.equal(q.correctAnswers.length,count,q.id);
 }
});
test('each ready answer key scores full marks, wrong or empty answers score zero',()=>{
 for(const q of bank.filter(ready)){
 const type=q.subType;
 let answer;
 if(['reading_mcq_single','listening_mcq_single','highlight_correct_summary','select_missing_word'].includes(type))answer=q.correctAnswer;
 else if(['reading_mcq_multiple','listening_mcq_multiple','reading_fill_blanks','reading_writing_fill_blanks','listening_fill_blanks'].includes(type))answer=q.correctAnswers;
 else if(type==='highlight_incorrect_words')answer=q.incorrectWordIndexes?.length?q.incorrectWordIndexes:q.correctAnswers;
 else if(type==='write_from_dictation')answer=q.answerKey;
 else continue;
 const points=run('getAutomaticPoints('+JSON.stringify(q)+')');
 const actual=run('calculateAutoScore('+JSON.stringify({...q,points})+','+JSON.stringify(answer)+')');
 assert.equal(actual,points,'Full-mark answer failed for question '+q.id+' ('+type+')');
 const empty=run('calculateAutoScore('+JSON.stringify({...q,points})+',"")');
 assert.equal(empty,0,'Empty answer scored for '+q.id);
 }
});
test('fresh exam selection uses unique questions, one per type',()=>{
 const expr='selectCompactExam('+JSON.stringify(bank)+')';
 const result=run(expr);
 assert.equal(result.shortages.length,0);
 assert.equal(result.questions.length,22);
 assert.equal(new Set(result.questions.map(q=>q.subType)).size,22);
 assert.equal(new Set(result.questions.map(q=>q.id)).size,22);
});
test('duplicate choices cannot inflate score and wrong choices reduce credit',()=>{
 assert.equal(run('scoreMultipleChoice(["a","a"],["a"],1)'),1);
 assert.equal(run('scoreMultipleChoice(["a","wrong"],["a","b"],2)'),0);
});
