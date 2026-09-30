const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname + '/server.js', 'utf8');
const scoring = source.slice(source.indexOf('function normalizeText('), source.indexOf('function ensureFile('));
const selection = source.slice(source.indexOf('const FULL_EXAM_COUNTS'), source.indexOf('app.post("/create-exam"'));
const context = vm.createContext({console});
vm.runInContext(scoring + selection, context);
const run = text => vm.runInContext(text, context);

test('65-item blueprint and strict shortage detection', () => {
  assert.equal(run('Object.values(FULL_EXAM_COUNTS).reduce((a,b)=>a+b,0)'), 65);
  assert.equal(run('selectFullExam([]).shortages.length'), 22);
});

test('no duplicates and no missing recordings in full exam', () => {
  run(`var bank = Object.entries(FULL_EXAM_COUNTS).flatMap(([subType,n]) =>
    Array.from({length:n+1},(_,i)=>({id:subType+i,subType,prompt:'instruction',
      type:subType.includes('listening')?'listening':'speaking',
      textContent:'passage '+i+' _______',audioUrl:'/audio/'+subType+i,
      imageUrl:'/image/'+subType+i,options:['a','b'],correctAnswer:'a',
      correctAnswers:['a'],answerKey:'1,2'})));
    var result = selectFullExam(bank);
  `);
  assert.equal(run('result.questions.length'), 65);
  assert.equal(run('new Set(result.questions.map(q=>q.id)).size'), 65);
  assert.equal(run('isExamReady({type:"listening",prompt:"test",textContent:"test",audioUrl:""})'), false);
  assert.equal(run('selectFullExam(Array(10).fill(bank[0])).questions.length'), 0);
});

test('negative marking and duplicate selections cannot inflate scores', () => {
  assert.equal(run('scoreMultipleChoice(["a","x"],["a","b"],10)'), 0);
  assert.equal(run('scoreMultipleChoice(["a","a"],["a"],10)'), 10);
  assert.equal(run('scoreMultipleChoice(["x"],["a"],10)'), 0);
  assert.equal(run('calculateAutoScore({subType:"highlight_incorrect_words",textContent:"a b c",incorrectWordIndexes:[1],points:10},["1"])'), 10);
  assert.equal(run('scoreDictation("the the","the cat",10)'), 5);
});

test('empty assigned responses receive zero without calling AI', async () => {
  const enrich = source.slice(source.indexOf('async function enrichAnswersWithScores('), source.indexOf('app.get("/",'));
  vm.runInContext('function normalizeQuestion(q){return q;}\n' + enrich, context);
  const results = await run('enrichAnswersWithScores([{questionId:"1",type:"speaking",answer:""}],[{id:"1",points:25}])');
  assert.equal(results[0].finalScore,0);
  assert.equal(results[0].maxScore,25);
});

test('deadlines include elapsed time after tab suspension', () => {
  const html = fs.readFileSync(__dirname + '/../client/exam.html','utf8');
  const countdown = html.slice(html.indexOf('    function countdownDeadline('),html.indexOf('    function startPartOneTimer('));
  let now = 100000;
  const values = new Map();
  const clock = vm.createContext({Date:{now:()=>now},localStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)}});
  vm.runInContext(countdown,clock);
  const deadline = vm.runInContext('countdownDeadline("reading",60)',clock);
  now += 45000;
  assert.equal(vm.runInContext(`secondsRemaining(${deadline})`,clock),15);
  assert.equal(vm.runInContext('countdownDeadline("reading",60)',clock),deadline);
  now += 20000;
  assert.equal(vm.runInContext(`secondsRemaining(${deadline})`,clock),0);
});
